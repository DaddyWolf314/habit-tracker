import { DurableObject } from "cloudflare:workers";
import type { ZodType } from "zod";
import { ulid } from "#/lib/ulid.ts";
import { validateAmendment } from "#/shared/amendment-validation.ts";
import type { Amendment, AmendmentInput } from "#/shared/amendments.ts";
import { amendmentInputSchema } from "#/shared/amendments.ts";
import {
	type AnchorView,
	anchorElapsedDays,
	anchorElapsedMs,
	resetAnchor,
} from "#/shared/anchors.ts";
import type {
	Counter,
	CounterDefinition,
	CreateCounterInput,
} from "#/shared/counters.ts";
import {
	applyCounterOp,
	type EffectOp,
	evaluateRules,
	type RuleEventContext,
	reevaluate,
	routeClosedTimerDuration,
	rulesEffectiveAt,
} from "#/shared/engine.ts";
import {
	type AwaitingEntry,
	awaitingKeysFor,
	type EventType,
	eventTypeSchema,
} from "#/shared/event-types.ts";
import type { Event, EventView, LogEventInput } from "#/shared/events.ts";
import {
	amendmentToExportRow,
	anchorToExportRow,
	counterToExportRow,
	eventToExportRow,
	ruleToExportRow,
	timerToExportRow,
} from "#/shared/export.ts";
import type {
	ConsentEntry,
	CoupleExport,
	CoupleStatus,
	Device,
	RoleAssignment,
	RoleConfirmationState,
	Session,
} from "#/shared/identity.ts";
import type {
	AuditEntry,
	IntrospectionResult,
} from "#/shared/introspection.ts";
import { explainProjection } from "#/shared/introspection.ts";
import { type Floor, satisfiesFloor } from "#/shared/journaling.ts";
import {
	RULE_CHANGE_ACTION_PREFIX,
	type RuleChangeKind,
	type RuleChangeNotice,
	ruleChangeAction,
	ruleChangeKindFromAction,
	unreadCount,
} from "#/shared/notifications.ts";
import {
	applyCounterEvent,
	compositeMetadata,
	deriveEventView,
} from "#/shared/projections.ts";
import type { RecoveryState, RecoveryView } from "#/shared/recovery.ts";
import {
	canFinalize,
	RECOVERY_WAIT_MS,
	recoveryView,
} from "#/shared/recovery.ts";
import {
	type MetadataValue,
	type Role,
	resolveSubjectRole,
	type Visibility,
} from "#/shared/roles.ts";
import { reconcilePack } from "#/shared/rule-reconciliation.ts";
import { validateRule, validateRuleVersion } from "#/shared/rule-validation.ts";
import type {
	Rule,
	RuleDefinition,
	RuleIdentity,
	RuleOrigin,
	RuleVersion,
	VersionedRule,
} from "#/shared/rules.ts";
import {
	latestVersion,
	ruleDefinitionSchema,
	ruleSchema,
	versionFromDefinition,
} from "#/shared/rules.ts";
import { catchUpFireAt, dueItems, earliestFireAt } from "#/shared/scheduler.ts";
import {
	DAY_MS,
	nextDailyRollover,
	nextStreak,
	nextWeeklyRollover,
	targetMet,
	WEEK_MS,
} from "#/shared/streaks.ts";
import {
	assignCountdownInputSchema,
	type Countdown,
	closeStopwatch,
	countdownExpiryAt,
	DEFAULT_STOPWATCH_MAX_MS,
	durationMinutes,
	extendCountdown,
	extendTimerInputSchema,
	isCountdownExpired,
	matchStopwatch,
	type OpenStopwatch,
	pauseCountdown,
	reprojectAcrossPause,
	resumeCountdown,
	STOPWATCH_MAX_MS_BY_ACTIVITY,
	stopwatchDurationMs,
	stopwatchExpiryAt,
	stopwatchesToAutoClose,
	type TimerView,
} from "#/shared/timers.ts";
import {
	amendmentCause,
	type CounterTrace,
	causeColumns,
	decodeTraceRow,
	directCause,
	encodeDetail,
	ruleCause,
	type TraceCause,
	type TraceEntry,
	type TraceRow,
	type TraceRowColumns,
	traceAnchor,
	traceAutoClose,
	traceCounter,
	traceExpire,
	traceNearMiss,
	traceNotify,
	traceScheduledReset,
	traceStreakRollover,
	traceTimerClose,
	traceTimerCommand,
	traceTimerOpen,
	traceTimerSkipped,
} from "#/shared/trace.ts";
import {
	exportView,
	visibilityAllowedForType,
	visibleView,
} from "#/shared/visibility.ts";
import {
	COUNTER_ADJUSTED_TYPE,
	COUNTER_RESET_TYPE,
	DEFAULT_ANCHORS,
	DEFAULT_COUNTERS,
	DEFAULT_EVENT_TYPES,
	DEFAULT_JOURNAL_DEADLINE_MS,
	DEFAULT_RULES,
	DEFAULT_TIMERS,
	EVENT_TYPES_VERSION,
	isBuiltinType,
	isReservedTypeId,
	JOURNAL_COUNTDOWN_TIMER,
	RULE_PACK_VERSION,
} from "#/templates/index.ts";
import { coupleError } from "./errors.ts";
import { runMigrations } from "./migrations.ts";

/** Derives a stable, url-safe counter id from a human name. */
function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/** Persisted shape of an in-flight role proposal (in the settings table). */
interface RoleProposal {
	proposed_by: string;
	assignment: RoleAssignment;
	confirmed_by: string[];
}

interface MemberRow {
	id: string;
	identity_hash: string;
	role: string | null;
	joined_at: number;
	[key: string]: SqlStorageValue;
}

interface DeviceRow {
	device_id: string;
	token_hash: string;
	label: string | null;
	created_at: number;
	revoked_at: number | null;
	[key: string]: SqlStorageValue;
}

interface EventRow {
	id: string;
	type: string;
	actor: string;
	subject: string | null;
	occurred_at: number;
	logged_at: number;
	metadata: string;
	note: string | null;
	visibility: string;
	[key: string]: SqlStorageValue;
}

interface AmendmentRow {
	id: string;
	target_event_id: string;
	kind: string;
	actor: string;
	created_at: number;
	patch: string | null;
	note: string | null;
	supersedes: string | null;
	[key: string]: SqlStorageValue;
}

interface CounterRow {
	id: string;
	definition: string;
	value: number;
	updated_at: number | null;
	[key: string]: SqlStorageValue;
}

/**
 * The `audit_log` actor for changes the shipped rule pack makes (#64, user story
 * 33) — a pack bump has no member behind it. Distinct from every member id, so
 * an upstream-changed row counts toward *both* members' unread rule changes.
 */
const PACK_ACTOR = "pack";

/** A row in the `rules` identity table: a stable id plus its provenance (#64). */
interface RuleIdentityRow {
	id: string;
	origin: string;
	adopted: number;
	upstream_changed: number;
	[key: string]: SqlStorageValue;
}

/** A row in the `rule_versions` table: one effective-dated revision (#64). */
interface RuleVersionRow {
	rule_id: string;
	effective_from: number;
	definition: string;
	enabled: number;
	[key: string]: SqlStorageValue;
}

/** A row in the `anchors` table: one elapsed-since anchor's reset timestamp. */
interface AnchorRow {
	id: string;
	/** The last reset's `occurred_at`; null until a rule first resets the anchor. */
	since: number | null;
	[key: string]: SqlStorageValue;
}

/** A row in the `schedule` table: one job the single alarm fires (handoff §3.2). */
interface ScheduleRow {
	id: string;
	next_fire_at: number;
	kind: string;
	/** JSON job params; `{ interval_ms }` marks a recurring job (else one-shot). */
	payload: string | null;
	[key: string]: SqlStorageValue;
}

/** The parsed `ScheduleRow.payload`. A positive `interval_ms` makes the job recur. */
interface SchedulePayload {
	interval_ms?: number;
	[key: string]: unknown;
}

/** A row in the `timers` table: one in-flight or closed timer instance. */
interface TimerRow {
	id: string;
	kind: string;
	/** The timer definition name, e.g. `session_stopwatch`. */
	definition: string;
	/** JSON `TimerState` — the match keys, tag, and derived/countdown fields. */
	state: string;
	status: string | null;
	opened_at: number | null;
	closed_at: number | null;
	[key: string]: SqlStorageValue;
}

/** The per-instance timer state carried in `TimerRow.state` (JSON). */
interface TimerState {
	/** The ref match the opening event pinned, e.g. `{ session_id: "s1" }`. */
	match?: Record<string, MetadataValue>;
	/** The opening `activity`, driving the per-activity max and duration routing. */
	tag?: string;
	/** Derived duration, set on close. */
	duration_ms?: number;
	/**
	 * Real end time of a session whose stopwatch the over-max sweep had already
	 * auto-closed, recorded when the genuine `session_ended` arrives so a review can
	 * see the true span (handoff §4.5). Present only on reconciled auto-closes.
	 */
	actual_ended_at?: number;
	/** Countdown deadline (#30). */
	deadline_at?: number;
	/** When a countdown was paused (#30); null/absent while running. */
	paused_at?: number;
	/** Remaining time captured at pause (#30). */
	remaining_ms?: number;
}

/** The resolved timer effect op (open/close) produced by the rule engine. */
type TimerOp = Extract<EffectOp, { kind: "timer" }>;

/**
 * The raw stored columns of a trace row. Kept here (not in the isomorphic shared
 * module) because the SqlStorage index signature is a Workers type; it is
 * structurally a `TraceRowColumns`, so `decodeTraceRow` reads it directly.
 */
interface TraceColumnsRow extends TraceRowColumns {
	[key: string]: SqlStorageValue;
}

/**
 * CoupleDO — one SQLite-backed Durable Object per couple (handoff §3.2). It owns
 * all relationship data: members, roles, devices, the event log, amendments,
 * rules, projections, schedules, and the live WebSocket sessions. Correctness-
 * critical sequences (pairing, event append → rule eval → projection update →
 * broadcast, pause-everything) run serialized in this single event loop.
 *
 * Phase 1 adds the identity/pairing state machine: binding members, minting and
 * revoking device tokens, the invite flow, and mutual role confirmation.
 *
 * Phase 2 adds the event log and counters: the per-couple event-type schema set
 * (starter seven), the append-only log with `counter_adjusted` direct-
 * manipulation sugar, materialized counter values (a cache rebuildable by
 * replay), and a trace row for every projection change.
 *
 * Phase 3 adds the rules engine: the R1–R18 default pack installed as a
 * versioned template, creation-time rule validation, and the append-time
 * evaluation that fires effects, folds counter changes into the cache, and
 * records near-miss traces for conditional rules waiting on adjudication. Timers
 * and amendments still land in Phases 4–5.
 */
export class CoupleDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	/**
	 * Set by applyEffectOp's timer branch so appendEvent re-arms the alarm only when a
	 * rule actually opened or closed a timer — the vast majority of events touch none,
	 * and re-arming reads the schedule and every open-timer row.
	 */
	private timersDirty = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		// Lazy, idempotent per-DO migrations; block so no request sees a
		// half-migrated schema (handoff §3.5). Seeding the event-type defaults is
		// reconciled the same way — version-guarded on every wake — so couples
		// paired before Phase 2 shipped get backfilled the first time their DO
		// wakes, not just at creation.
		ctx.blockConcurrencyWhile(async () => {
			runMigrations(this.sql);
			this.ensureSeeded();
			this.ensureRulePackSeeded();
			// Backfill the rollover schedule for couples active before #33 shipped,
			// and re-arm the single alarm on every wake so it survives eviction.
			this.ensureRolloverScheduled();
			this.armAlarm();
		});
	}

	// ── Couple / member state ────────────────────────────────────────────────

	/**
	 * Binds the founding partner and opens the couple for pairing. Rejects if the
	 * couple already has any member — a DO is created fresh per couple.
	 */
	async createCouple(identityHash: string): Promise<{ member_id: string }> {
		if (this.members().length > 0) {
			throw coupleError("CONFLICT", "couple already created");
		}
		const memberId = crypto.randomUUID();
		this.sql.exec(
			`INSERT INTO members (id, identity_hash, role, joined_at) VALUES (?, ?, NULL, ?)`,
			memberId,
			identityHash,
			Date.now(),
		);
		this.setSetting("status", "pairing");
		this.setSetting("invitations_closed", "0");
		return { member_id: memberId };
	}

	/**
	 * Binds the second partner via a redeemed invite and permanently closes
	 * invitations — so no third member can ever be added (handoff §2). Rejects if
	 * the couple is already full, invitations are closed, or the identity is
	 * already a member.
	 */
	async joinCouple(identityHash: string): Promise<{ member_id: string }> {
		this.assertLive();
		if (this.getSetting("invitations_closed") === "1") {
			throw coupleError("GONE", "invitations are closed");
		}
		const members = this.members();
		if (members.length === 0)
			throw coupleError("BAD_REQUEST", "couple not initialized");
		if (members.length >= 2) throw coupleError("CONFLICT", "couple is full");
		if (members.some((m) => m.identity_hash === identityHash)) {
			throw coupleError("CONFLICT", "already a member of this couple");
		}
		const memberId = crypto.randomUUID();
		this.sql.exec(
			`INSERT INTO members (id, identity_hash, role, joined_at) VALUES (?, ?, NULL, ?)`,
			memberId,
			identityHash,
			Date.now(),
		);
		// Permanently close the couple to further members.
		this.setSetting("invitations_closed", "1");
		return { member_id: memberId };
	}

	/** Whoami for a member, plus couple-level status. */
	async getState(identityHash: string): Promise<Session> {
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		const status = this.status();
		return {
			couple_do_id: this.ctx.id.toString(),
			member_id: member.id,
			identity_hash: identityHash,
			role: (member.role as Session["role"]) ?? null,
			status,
			member_count: this.members().length,
			invitations_closed: this.getSetting("invitations_closed") === "1",
			roles_active: status === "active",
			paused: this.isPaused(),
			recovery_pending: this.recoveryState() !== null,
		};
	}

	// ── Mutual role confirmation (handoff §2) ────────────────────────────────

	/**
	 * Proposes a role assignment covering both members. The proposer implicitly
	 * confirms; the dynamic stays inactive until the partner confirms too. A new
	 * proposal supersedes any prior one.
	 */
	async proposeRoles(
		identityHash: string,
		assignment: RoleAssignment,
	): Promise<RoleConfirmationState> {
		const me = this.requireMember(identityHash);
		this.assertLive();
		if (this.status() === "active") {
			throw coupleError("CONFLICT", "roles are already confirmed");
		}
		const members = this.members();
		if (members.length < 2)
			throw coupleError("BAD_REQUEST", "the couple is not paired yet");

		const ids = members.map((m) => m.id).sort();
		const assignedIds = Object.keys(assignment).sort();
		if (
			ids.length !== assignedIds.length ||
			ids.some((id, i) => id !== assignedIds[i])
		) {
			throw coupleError(
				"BAD_REQUEST",
				"assignment must cover both members exactly",
			);
		}

		const proposal: RoleProposal = {
			proposed_by: me.id,
			assignment,
			confirmed_by: [me.id],
		};
		this.setSetting("role_proposal", JSON.stringify(proposal));
		return this.roleState(identityHash);
	}

	/**
	 * Confirms the standing proposal. When both members have confirmed, roles are
	 * written, the dynamic activates, and the confirmation becomes the first entry
	 * in the consent history.
	 */
	async confirmRoles(identityHash: string): Promise<RoleConfirmationState> {
		const me = this.requireMember(identityHash);
		this.assertLive();
		if (this.status() === "active") return this.roleState(identityHash);
		const proposal = this.proposal();
		if (!proposal)
			throw coupleError("BAD_REQUEST", "there is no role proposal to confirm");

		if (!proposal.confirmed_by.includes(me.id)) {
			proposal.confirmed_by.push(me.id);
			this.setSetting("role_proposal", JSON.stringify(proposal));
		}

		const everyone = this.members().every((m) =>
			proposal.confirmed_by.includes(m.id),
		);
		if (everyone) this.activateRoles(proposal.assignment);
		return this.roleState(identityHash);
	}

	/** Current role-confirmation state for the caller. */
	async getRoleState(identityHash: string): Promise<RoleConfirmationState> {
		this.requireMember(identityHash);
		return this.roleState(identityHash);
	}

	/** The append-only agreement/consent history (newest first). */
	async listConsentHistory(identityHash: string): Promise<ConsentEntry[]> {
		this.requireMember(identityHash);
		return this.sql
			.exec<{
				id: string;
				at: number;
				kind: string;
				detail: string | null;
			}>(`SELECT id, at, kind, detail FROM consent_history ORDER BY at DESC`)
			.toArray()
			.map((row) => ({
				id: row.id,
				at: row.at,
				kind: row.kind,
				detail: row.detail,
			}));
	}

	private activateRoles(assignment: RoleAssignment): void {
		for (const [memberId, role] of Object.entries(assignment)) {
			this.sql.exec(`UPDATE members SET role = ? WHERE id = ?`, role, memberId);
		}
		this.setSetting("status", "active");
		this.sql.exec(
			`INSERT INTO consent_history (id, at, kind, detail) VALUES (?, ?, 'roles_confirmed', ?)`,
			crypto.randomUUID(),
			Date.now(),
			JSON.stringify({ assignment }),
		);
		// The dynamic is live: start the day/week rollover schedule and arm the alarm.
		this.ensureRolloverScheduled();
		this.armAlarm();
	}

	private roleState(identityHash: string): RoleConfirmationState {
		const me = this.memberByIdentity(identityHash);
		const proposal = this.proposal();
		return {
			members: this.members().map((m) => ({
				member_id: m.id,
				role:
					(m.role as RoleConfirmationState["members"][number]["role"]) ?? null,
				is_self: m.id === me?.id,
			})),
			assignment: proposal?.assignment ?? null,
			proposed_by: proposal?.proposed_by ?? null,
			confirmed_by: proposal?.confirmed_by ?? [],
			active: this.status() === "active",
		};
	}

	private proposal(): RoleProposal | null {
		const raw = this.getSetting("role_proposal");
		return raw ? (JSON.parse(raw) as RoleProposal) : null;
	}

	private requireMember(identityHash: string): MemberRow {
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		return member;
	}

	private assertLive(): void {
		if (this.status() === "dissolved") {
			throw coupleError("GONE", "this couple has been dissolved");
		}
	}

	// ── Pause-everything / safeword (handoff §9, #40) ─────────────────────────

	/** When the couple was paused (safeword), or null while running. */
	private pausedAt(): number | null {
		const raw = this.getSetting("paused_at");
		return raw ? Number(raw) : null;
	}

	/** Whether the safeword is engaged: all tracking frozen, no consequences accrue. */
	private isPaused(): boolean {
		return this.pausedAt() !== null;
	}

	/** Freezes tracking mutations while the safeword is engaged. */
	private assertNotPaused(): void {
		if (this.isPaused()) {
			throw coupleError(
				"CONFLICT",
				"everything is paused — resume to continue",
			);
		}
	}

	// ── Dissolve + export (handoff §2, abuse-edge) ───────────────────────────

	/**
	 * Either member can unilaterally dissolve the pairing: freeze the dynamic and
	 * suspend the schedule. Full teardown (offer export → delete the DO → purge
	 * routing rows) lands in Phase 6; this stub freezes and records the event.
	 */
	async dissolve(identityHash: string): Promise<{ status: CoupleStatus }> {
		this.requireMember(identityHash);
		if (this.status() !== "dissolved") {
			this.setSetting("status", "dissolved");
			this.ctx.storage.deleteAlarm();
			this.sql.exec(
				`INSERT INTO consent_history (id, at, kind, detail) VALUES (?, ?, 'dissolved', NULL)`,
				crypto.randomUUID(),
				Date.now(),
			);
		}
		return { status: "dissolved" };
	}

	/**
	 * Irreversibly deletes this couple's Durable Object storage — the final step
	 * of dissolve → export → delete (handoff §3.5). Gated on a prior dissolve so a
	 * member cannot skip the freeze-and-export-offer window; the abuse-edge
	 * guarantee is that no one is trapped, not that anyone can nuke a live couple
	 * out from under their partner without warning. `deleteAll` wipes every SQL
	 * table, KV pair, and the alarm, so the DO retains no relationship data; the
	 * caller (routing layer) then purges the credential/invite rows that point
	 * here, making "the database ceases to exist" literally true.
	 */
	async purge(identityHash: string): Promise<{ couple_do_id: string }> {
		this.requireMember(identityHash);
		if (this.status() !== "dissolved") {
			throw coupleError("BAD_REQUEST", "dissolve the couple before deleting");
		}
		const coupleDoId = this.ctx.id.toString();
		await this.ctx.storage.deleteAll();
		return { couple_do_id: coupleDoId };
	}

	/**
	 * Pause-everything / safeword (handoff §9): either partner, one tap, no
	 * questions. Freezes all tracking (mutations are refused until resume) and
	 * suspends the single alarm so no consequence — a countdown expiry, an
	 * over-max stopwatch, a rollover — can fire while paused. Nothing is *logged*
	 * as a failure: the sweeps early-return while paused, so a countdown whose
	 * deadline falls inside the paused window simply waits. One serialized DO
	 * state transition; idempotent, so a double-tap is harmless.
	 */
	async pause(
		identityHash: string,
	): Promise<{ paused: boolean; paused_at: number | null }> {
		this.requireMember(identityHash);
		this.assertLive();
		const existing = this.pausedAt();
		if (existing !== null) return { paused: true, paused_at: existing };
		const now = Date.now();
		this.setSetting("paused_at", String(now));
		this.ctx.storage.deleteAlarm();
		this.sql.exec(
			`INSERT INTO consent_history (id, at, kind, detail) VALUES (?, ?, 'paused', NULL)`,
			crypto.randomUUID(),
			now,
		);
		return { paused: true, paused_at: now };
	}

	/**
	 * Lifts the safeword and restores prior state cleanly (handoff §9). The paused
	 * wall-clock duration is handed back to every open timer so the freeze stole no
	 * time: running countdowns shift their deadline out by exactly that long (an
	 * individually dom-paused countdown is left frozen), and open stopwatches shift
	 * `opened_at` so neither their elapsed nor their over-max expiry counts the
	 * pause. The alarm is then re-armed at the new minimum. Idempotent.
	 */
	async resume(identityHash: string): Promise<{ paused: boolean }> {
		this.requireMember(identityHash);
		const pausedAt = this.pausedAt();
		if (pausedAt === null) return { paused: false };
		const now = Date.now();
		const pausedMs = Math.max(0, now - pausedAt);
		for (const row of this.openTimerRowsAll()) {
			if (row.kind === "countdown") {
				const patch = reprojectAcrossPause(this.rowToCountdown(row), pausedMs);
				if (patch) this.patchTimerState(row, patch);
			} else if (row.kind === "stopwatch" && row.opened_at !== null) {
				this.sql.exec(
					`UPDATE timers SET opened_at = ? WHERE id = ?`,
					row.opened_at + pausedMs,
					row.id,
				);
			}
		}
		this.sql.exec(`DELETE FROM settings WHERE key = ?`, "paused_at");
		this.sql.exec(
			`INSERT INTO consent_history (id, at, kind, detail) VALUES (?, ?, 'resumed', NULL)`,
			crypto.randomUUID(),
			now,
		);
		this.armAlarm();
		return { paused: false };
	}

	// ── Partner-assisted recovery (handoff §2, #41) ───────────────────────────

	/** The active recovery, or null. Stored as JSON — at most one at a time. */
	private recoveryState(): RecoveryState | null {
		const raw = this.getSetting("recovery");
		return raw ? (JSON.parse(raw) as RecoveryState) : null;
	}

	private writeRecovery(state: RecoveryState): void {
		this.setSetting("recovery", JSON.stringify(state));
	}

	private clearRecovery(): void {
		this.sql.exec(`DELETE FROM settings WHERE key = ?`, "recovery");
	}

	private recordConsent(kind: string, at: number): void {
		this.sql.exec(
			`INSERT INTO consent_history (id, at, kind, detail) VALUES (?, ?, ?, NULL)`,
			crypto.randomUUID(),
			at,
			kind,
		);
	}

	/**
	 * The remaining partner starts recovery of the *other* member's slot (handoff
	 * §2): a takeover cannot begin without this authenticated action. Sets the
	 * mandatory waiting window (`rebind_at = now + 24h`) during which the lost
	 * identity's remaining devices can cancel, and records the start so it is
	 * visible in the consent history. The Worker mints the single-use code.
	 */
	async startRecovery(
		identityHash: string,
	): Promise<{ member_id: string; rebind_at: number }> {
		const me = this.requireMember(identityHash);
		this.assertLive();
		const members = this.members();
		if (members.length < 2) {
			throw coupleError("BAD_REQUEST", "recovery needs a paired couple");
		}
		if (this.recoveryState()) {
			throw coupleError("CONFLICT", "a recovery is already in progress");
		}
		const other = members.find((m) => m.id !== me.id);
		if (!other) throw coupleError("BAD_REQUEST", "no partner slot to recover");
		const now = Date.now();
		const rebind_at = now + RECOVERY_WAIT_MS;
		this.writeRecovery({
			member_id: other.id,
			started_by: me.id,
			old_identity_hash: other.identity_hash,
			rebind_at,
			status: "pending",
			new_identity_hash: null,
			new_credential_hash: null,
		});
		this.recordConsent("recovery_started", now);
		return { member_id: other.id, rebind_at };
	}

	/**
	 * Binds the lost-token member's *fresh* identity to the pending recovery
	 * (handoff §2). The slot does not rebind yet — that waits out the window and a
	 * final `finalizeRecovery`. The fresh identity may not already be a member.
	 */
	async redeemRecovery(
		newIdentityHash: string,
		newCredentialHash: string,
	): Promise<{ member_id: string; rebind_at: number }> {
		const state = this.recoveryState();
		if (!state || state.status !== "pending") {
			throw coupleError("NOT_FOUND", "no recovery awaiting redemption");
		}
		if (this.memberByIdentity(newIdentityHash)) {
			throw coupleError("CONFLICT", "already a member of this couple");
		}
		this.writeRecovery({
			...state,
			status: "redeemed",
			new_identity_hash: newIdentityHash,
			new_credential_hash: newCredentialHash,
		});
		return { member_id: state.member_id, rebind_at: state.rebind_at };
	}

	/**
	 * Interrupts a recovery (handoff §2 — the stolen-phone escape valve). Either
	 * member may cancel; the old identity cancelling from a remaining device is the
	 * whole point of the waiting window. Returns the fresh identity's routing
	 * credential so the Worker can revoke it. Idempotent.
	 */
	async cancelRecovery(
		identityHash: string,
	): Promise<{ new_credential_hash: string | null }> {
		this.requireMember(identityHash);
		const state = this.recoveryState();
		if (!state) return { new_credential_hash: null };
		this.clearRecovery();
		this.recordConsent("recovery_cancelled", Date.now());
		return { new_credential_hash: state.new_credential_hash };
	}

	/**
	 * Rebinds the member slot to the fresh identity once the window has elapsed
	 * (handoff §2), then hands the Worker the old identity so its routing
	 * credentials can be revoked. Only the fresh identity that redeemed may
	 * finalize, and only after the full waiting period — the timing gate is the
	 * pure `canFinalize`. The old identity's device rows are dropped here so the
	 * lost/stolen tokens stop working couple-side too.
	 */
	async finalizeRecovery(
		callerIdentityHash: string,
	): Promise<{ old_identity_hash: string; new_identity_hash: string }> {
		const state = this.recoveryState();
		if (!state) throw coupleError("NOT_FOUND", "no recovery in progress");
		if (callerIdentityHash !== state.new_identity_hash) {
			throw coupleError("FORBIDDEN", "not the recovering identity");
		}
		if (!canFinalize(state, Date.now())) {
			throw coupleError("CONFLICT", "the waiting period has not elapsed");
		}
		// Proven equal by the guard above, and non-null (a redeemed recovery always
		// carries the fresh identity that redeemed it).
		const newIdentityHash = callerIdentityHash;
		this.sql.exec(
			`UPDATE members SET identity_hash = ? WHERE id = ?`,
			newIdentityHash,
			state.member_id,
		);
		// The lost/stolen devices belonged to the old identity; drop them so they
		// stop resolving couple-side (the Worker revokes their routing rows too).
		this.sql.exec(`DELETE FROM devices WHERE member_id = ?`, state.member_id);
		this.clearRecovery();
		this.recordConsent("recovery_completed", Date.now());
		return {
			old_identity_hash: state.old_identity_hash,
			new_identity_hash: newIdentityHash,
		};
	}

	/**
	 * A member's view of the active recovery (for polling / the cancel prompt). The
	 * redeemed fresh identity is *not* a member until `finalizeRecovery` rebinds the
	 * slot, yet it must be able to poll the window it is waiting out (handoff §2) —
	 * so allow either a member or that redeemed identity, mirroring how finalize
	 * itself gates on `new_identity_hash` rather than membership.
	 */
	async getRecovery(identityHash: string): Promise<RecoveryView | null> {
		const state = this.recoveryState();
		const isMember = this.memberByIdentity(identityHash) !== null;
		const isRecovering = state?.new_identity_hash === identityHash;
		if (!isMember && !isRecovering) {
			throw coupleError("NOT_FOUND", "not a member of this couple");
		}
		return state ? recoveryView(state, Date.now()) : null;
	}

	// ── Content-free notifications (handoff §3.5, #42) ─────────────────────────

	/**
	 * The content-free unread count for the caller (#42) — a number only, never any
	 * relationship content, so the notification badge it drives ("You have N new
	 * items") reveals nothing. Counts the events awaiting an adjudication plus a
	 * pending recovery worth noticing.
	 *
	 * The recovery signal is *targeted*, not broadcast: only the member whose slot
	 * is being recovered — the old identity that can still cancel from a remaining
	 * device — sees it, delivering the spec's "notice pushed to the old identity's
	 * remaining devices" (#41) rather than a badge that fires identically for the
	 * partner who started the takeover and already knows.
	 */
	async notificationCount(identityHash: string): Promise<{ unread: number }> {
		const me = this.requireMember(identityHash);
		const events = await this.listEvents(identityHash);
		const recovery = this.recoveryState();
		return {
			unread: unreadCount({
				pending_events: events.filter((e) => e.pending).length,
				recovery_pending: recovery !== null && recovery.member_id === me.id,
				rule_changes: this.ruleChangesUnseen(me.id),
			}),
		};
	}

	/**
	 * A member's exportable snapshot of the relationship — the abuse-edge escape
	 * hatch (handoff §2). Carries the member's full view: the event log and its
	 * amendments (which together reconstruct the composite truth), the installed
	 * rules, and the counter/timer/anchor projections. The per-object flattening
	 * lives in the shared `export` module so the shape is one testable seam.
	 */
	async exportData(identityHash: string): Promise<CoupleExport> {
		const me = this.requireMember(identityHash);
		const exportedAt = Date.now();
		// The one visibility branch in export (ADR 0001, #60): a sealed/secret entry
		// exports only to its author — the partner's export never contains it, not
		// even the existence row the log view shows. It is all-or-nothing (stricter
		// than the log funnel), so a kept entry carries all of its amendments and a
		// dropped one takes its amendments with it.
		const types = new Map(this.eventTypes().map((t) => [t.id, t]));
		const amendmentsByEvent = this.amendmentsByEvent();
		const events: CoupleExport["events"] = [];
		const amendments: CoupleExport["amendments"] = [];
		for (const row of this.eventRows()) {
			const event = this.rowToEvent(row);
			const eventAmendments = amendmentsByEvent.get(event.id) ?? [];
			const view = deriveEventView(
				event,
				eventAmendments,
				types.get(event.type),
				this.subjectRole(event.subject),
			);
			if (exportView(view, me.id) === null) continue;
			events.push(eventToExportRow(event));
			for (const amendment of eventAmendments) {
				amendments.push(amendmentToExportRow(amendment));
			}
		}
		return {
			exported_at: exportedAt,
			couple_do_id: this.ctx.id.toString(),
			status: this.status(),
			self: {
				member_id: me.id,
				role: (me.role as CoupleExport["self"]["role"]) ?? null,
			},
			members: this.members().map((m) => ({
				member_id: m.id,
				role: (m.role as CoupleExport["self"]["role"]) ?? null,
			})),
			devices: this.devicesOf(me.id).map((row) => ({
				device_id: row.device_id,
				label: row.label,
				created_at: row.created_at,
				revoked_at: row.revoked_at,
				current: false,
			})),
			consent_history: await this.listConsentHistory(identityHash),
			events,
			amendments,
			rules: this.currentRules().map(ruleToExportRow),
			counters: this.counterRows().map((row) =>
				counterToExportRow(this.rowToCounter(row)),
			),
			timers: this.timerRows().map((row) =>
				timerToExportRow(this.rowToTimerView(row)),
			),
			anchors: this.anchorRows().map((row) => {
				const elapsedMs = anchorElapsedMs(row.since, exportedAt);
				return anchorToExportRow({
					anchor: row.id,
					since: row.since,
					elapsed_ms: elapsedMs,
					elapsed_days: anchorElapsedDays(elapsedMs),
				});
			}),
		};
	}

	// ── Device tokens (handoff §2) ───────────────────────────────────────────

	/** Records a newly minted device token in the caller's member record. */
	async addDevice(
		identityHash: string,
		tokenHash: string,
		label: string | null,
	): Promise<Device> {
		this.assertLive();
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		const deviceId = crypto.randomUUID();
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO devices (token_hash, member_id, label, created_at, revoked_at, device_id)
				VALUES (?, ?, ?, ?, NULL, ?)`,
			tokenHash,
			member.id,
			label,
			now,
			deviceId,
		);
		return {
			device_id: deviceId,
			label,
			created_at: now,
			revoked_at: null,
			current: false,
		};
	}

	/**
	 * Lists the caller's devices for the "your devices" panel. The token hash is
	 * never returned; the device the caller is using is flagged `current`.
	 */
	async listDevices(
		identityHash: string,
		callerCredentialHash: string,
	): Promise<Device[]> {
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		return this.devicesOf(member.id).map((row) => ({
			device_id: row.device_id,
			label: row.label,
			created_at: row.created_at,
			revoked_at: row.revoked_at,
			current: row.token_hash === callerCredentialHash,
		}));
	}

	/**
	 * Revokes one device and returns its token hash so the caller can flip the
	 * matching routing-layer credential to revoked (auth rejects it thereafter).
	 */
	async revokeDevice(
		identityHash: string,
		deviceId: string,
	): Promise<{ token_hash: string }> {
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		const device = this.devicesOf(member.id).find(
			(d) => d.device_id === deviceId,
		);
		if (!device) throw coupleError("NOT_FOUND", "no such device");
		if (device.revoked_at === null) {
			this.sql.exec(
				`UPDATE devices SET revoked_at = ? WHERE device_id = ?`,
				Date.now(),
				deviceId,
			);
		}
		return { token_hash: device.token_hash };
	}

	// ── Event-type schemas (handoff §5, §6) ──────────────────────────────────

	/**
	 * Seeds the ship-time defaults if this DO hasn't reached the current template
	 * version yet. Runs on every wake (cheap: one settings read) so couples that
	 * predate a template — including everyone paired before Phase 2 — get
	 * backfilled without a bespoke migration.
	 */
	private ensureSeeded(): void {
		const seeded = Number(this.getSetting("event_types_version") ?? "0");
		if (seeded >= EVENT_TYPES_VERSION) return;
		this.seedDefaults();
	}

	/**
	 * Seeds the ship-time defaults into a couple: the starter seven plus the
	 * reserved counter-manipulation types. Upserts the *definition* on a version
	 * bump — mirroring the counter seeding — so a template revision (e.g. the
	 * orgasm type's subject-qualified `permitted` awaiting entry, ADR 0003)
	 * actually reaches already-seeded couples. Safe because starter types are
	 * pack-owned: there is no editing surface for them, so an upsert can never
	 * clobber a couple's customization (custom types have distinct ids and are
	 * untouched). Idempotent; the version is recorded to guard re-runs.
	 */
	private seedDefaults(): void {
		for (const type of DEFAULT_EVENT_TYPES) {
			this.sql.exec(
				`INSERT INTO event_types (id, definition) VALUES (?, ?)
					ON CONFLICT(id) DO UPDATE SET definition = excluded.definition`,
				type.id,
				JSON.stringify(type),
			);
		}
		this.setSetting("event_types_version", String(EVENT_TYPES_VERSION));
	}

	/**
	 * Installs the default projections & rule pack (handoff §7) if this DO hasn't
	 * reached the current pack version yet: the default counters the pack drives
	 * and R1–R18. Version-guarded and idempotent, mirroring {@link ensureSeeded},
	 * so couples paired before Phase 3 shipped get the pack the first time their
	 * DO wakes. Counters are seeded before rules so a rule's target exists.
	 */
	private ensureRulePackSeeded(): void {
		const seeded = Number(this.getSetting("rule_pack_version") ?? "0");
		if (seeded >= RULE_PACK_VERSION) return;
		// Upsert the *definition* on a version bump so a corrected default rule or
		// counter actually reaches already-seeded couples — INSERT OR IGNORE would
		// leave the stale body while advancing the version, silently stranding the
		// fix. A counter's live value/updated_at is preserved (only policy changes),
		// and a rule's `enabled` is preserved so a couple's toggle survives a bump.
		for (const counter of DEFAULT_COUNTERS) {
			this.sql.exec(
				`INSERT INTO counters (id, definition, value, updated_at)
					VALUES (?, ?, 0, NULL)
					ON CONFLICT(id) DO UPDATE SET definition = excluded.definition`,
				counter.id,
				JSON.stringify(counter),
			);
		}
		// Adopt-on-edit reconciliation (ADR 0002): install brand-new pack rules and
		// upsert un-adopted ones the pack changed, but never overwrite a rule the
		// couple has edited. On the very first seed everything is an add, effective
		// from 0 so the pack applies to the whole log; a later bump stamps changes at
		// the bump time so they only bind events logged after it (forward-only).
		const effectiveFrom = seeded === 0 ? 0 : Date.now();
		const reconciliation = reconcilePack(
			DEFAULT_RULES,
			this.versionedRules(),
			effectiveFrom,
		);
		for (const rule of reconciliation.added) {
			this.writeRuleVersion(
				{ id: rule.id, origin: rule.origin, adopted: rule.adopted },
				rule.versions[0] as RuleVersion,
			);
		}
		for (const { id, version } of reconciliation.upserted) {
			this.writeRuleVersion({ id, origin: "pack", adopted: false }, version);
		}
		// Adopted rules the bump skipped (#64, user story 33): never overwritten, but
		// when the shipped default now differs from the couple's edited definition,
		// say so — flag the rule for a "new default" badge and record one
		// system-actor audit row so both members' unread counts surface it. The flag
		// (not the audit row) is the state: it clears when the couple next edits the
		// rule, and a bump that finds no diff clears it too.
		for (const { id, changedUpstream } of reconciliation.skipped) {
			const alreadyFlagged = this.ruleIdentity(id)?.upstream_changed === 1;
			this.sql.exec(
				`UPDATE rules SET upstream_changed = ? WHERE id = ?`,
				changedUpstream ? 1 : 0,
				id,
			);
			if (changedUpstream && !alreadyFlagged) {
				this.sql.exec(
					`INSERT INTO audit_log (at, actor, action, target) VALUES (?, ?, ?, ?)`,
					effectiveFrom,
					PACK_ACTOR,
					ruleChangeAction("upstream_changed"),
					id,
				);
			}
		}
		// Anchors are pure state (an id + reset timestamp); seed each unset, and on a
		// version bump leave an existing anchor's `since` untouched — only the anchor
		// *set* is policy, and its live timestamp is a projection to preserve.
		for (const anchor of DEFAULT_ANCHORS) {
			this.sql.exec(
				`INSERT INTO anchors (id, since) VALUES (?, NULL) ON CONFLICT(id) DO NOTHING`,
				anchor,
			);
		}
		this.setSetting("rule_pack_version", String(RULE_PACK_VERSION));
	}

	/**
	 * The couple's installed rules (R1–R18 template + any custom) as a flat set,
	 * each at its current definition. Viewing is open to any member; this feeds the
	 * client-side ruling preview (the same rules the DO's `reevaluate` applies).
	 */
	async listRules(identityHash: string): Promise<Rule[]> {
		this.requireMember(identityHash);
		return this.currentRules();
	}

	/**
	 * The full rule set with provenance and effective-dated version history (#64)
	 * for the rules screen: origin (pack vs custom), whether a pack rule has been
	 * adopted (and whether its shipped default has since changed upstream), and
	 * every revision. Viewing is open to any member (a sub is never bound by a rule
	 * they cannot see). A pure read — acknowledging rule-change notices is the
	 * explicit {@link ackRuleChanges}, never a side effect of looking.
	 */
	async listRuleHistory(identityHash: string): Promise<VersionedRule[]> {
		this.requireMember(identityHash);
		return this.versionedRules();
	}

	/**
	 * The rule changes the caller hasn't acknowledged yet (#64, user stories 33 +
	 * 35): every change made by someone other than them — the partner's authoring
	 * actions plus the pack's upstream-changed flags — since they last acked. The
	 * rules screen composes each into a sentence (`ruleChangeNotice`), so the sub
	 * always learns the current terms; the same rows drive the unread-count badge.
	 */
	async listRuleChanges(identityHash: string): Promise<RuleChangeNotice[]> {
		const me = this.requireMember(identityHash);
		const seen = Number(this.getSetting(`rules_seen_at_${me.id}`) ?? "0");
		const rows = this.sql
			.exec<{ at: number; action: string; target: string | null }>(
				`SELECT at, action, target FROM audit_log
					WHERE action LIKE ? AND actor != ? AND at > ?
					ORDER BY at ASC, id ASC`,
				`${RULE_CHANGE_ACTION_PREFIX}%`,
				me.id,
				seen,
			)
			.toArray();
		return rows.flatMap((row) => {
			const kind = ruleChangeKindFromAction(row.action);
			return kind && row.target
				? [{ kind, rule_id: row.target, at: row.at }]
				: [];
		});
	}

	/**
	 * Marks the caller's rule-change notices seen (#64). The explicit
	 * acknowledgement the rules screen sends once the notices have been shown —
	 * kept out of the history read so a GET never mutates state.
	 */
	async ackRuleChanges(identityHash: string): Promise<void> {
		const me = this.requireMember(identityHash);
		this.markRuleChangesSeen(me.id);
	}

	/**
	 * Creates a custom rule (#64). Authoring is gated to dom/switch; the rule is
	 * validated against the couple's event-type schema and known projections at
	 * creation (handoff §4.3) — conditioning on a nonexistent key or targeting an
	 * unknown projection is rejected here, not silently skipped forever at runtime.
	 * Recorded as the rule's first effective-dated version, effective from now.
	 */
	async createRule(identityHash: string, definition: unknown): Promise<Rule> {
		const me = this.requireAuthor(identityHash);
		const rule = this.parseRulePayload(ruleSchema, definition);
		// The default pack owns the `R<n>` id namespace; a custom rule may not squat
		// an id a future pack version could ship (its reseed would then silently skip
		// the shipped rule, diverging this couple from every other).
		if (/^R\d+$/i.test(rule.id)) {
			throw coupleError(
				"BAD_REQUEST",
				"the R# id namespace is reserved for the default pack",
			);
		}
		if (this.ruleIdentity(rule.id)) {
			throw coupleError("CONFLICT", "a rule with that id already exists");
		}
		this.assertRuleFireable(rule);
		const validation = validateRule(rule, this.ruleValidationCtx());
		if (!validation.ok) throw coupleError("BAD_REQUEST", validation.error);
		const effectiveFrom = Date.now();
		this.writeRuleVersion(
			{ id: rule.id, origin: "custom", adopted: false },
			versionFromDefinition(rule, effectiveFrom),
		);
		this.recordRuleChange(me, "create", rule.id, effectiveFrom);
		return rule;
	}

	/**
	 * Edits an existing rule's condition and/or effects (#64). Authoring is gated to
	 * dom/switch. The edit appends a new effective-dated version rather than
	 * mutating in place, so events already logged keep the consequences they
	 * received (forward-only, ADR 0002). Editing a default-pack rule *adopts* it,
	 * freezing it against future pack overwrites. Validated identically to a create.
	 */
	async updateRule(
		identityHash: string,
		id: string,
		definition: unknown,
	): Promise<Rule> {
		const me = this.requireAuthor(identityHash);
		const existing = this.requireRule(id);
		const def = this.parseRulePayload(ruleDefinitionSchema, definition);
		const rule: Rule = { id, ...def };
		this.assertRuleFireable(rule);
		const effectiveFrom = Date.now();
		const version = versionFromDefinition(def, effectiveFrom);
		const validation = validateRuleVersion(
			id,
			version,
			this.ruleValidationCtx(),
		);
		if (!validation.ok) throw coupleError("BAD_REQUEST", validation.error);
		this.writeRuleVersion(this.editedIdentity(existing), version);
		// Editing answers the "new default available" notice (user story 33): the
		// member has seen the upstream default and chosen their definition anyway.
		this.sql.exec(`UPDATE rules SET upstream_changed = 0 WHERE id = ?`, id);
		this.recordRuleChange(me, "edit", id, effectiveFrom);
		return rule;
	}

	/**
	 * Enables or disables a rule (#64), gated to dom/switch. A disable is an
	 * effective-dated state change, not a deletion: it appends a version carrying
	 * the current definition with the new `enabled` flag, so the rule stops (or
	 * resumes) firing for events logged after the change while earlier events still
	 * replay under the version in force when they were logged. Toggling a pack rule
	 * adopts it.
	 */
	async setRuleEnabled(
		identityHash: string,
		id: string,
		enabled: boolean,
	): Promise<VersionedRule> {
		const me = this.requireAuthor(identityHash);
		const existing = this.requireRule(id);
		const current = latestVersion(existing);
		if (current.enabled === enabled) return existing; // no-op, no audit noise
		const effectiveFrom = Date.now();
		this.writeRuleVersion(
			this.editedIdentity(existing),
			versionFromDefinition({ ...current, enabled }, effectiveFrom),
		);
		this.recordRuleChange(
			me,
			enabled ? "enable" : "disable",
			id,
			effectiveFrom,
		);
		return this.requireRule(id);
	}

	/**
	 * Removes a rule (#64), gated to dom/switch. A true hard purge is allowed only
	 * for a custom rule that has never fired (zero trace references) — nothing in
	 * the log depends on it. Any pack rule, or any rule that has ever fired,
	 * collapses to a **disable** instead, so past events it affected still replay
	 * correctly (ADR 0002) — audited as `rule.disable`, the ADR op that actually
	 * happened. Every removal request writes an audit row, even a collapse onto an
	 * already-disabled rule (no version to append, but the actor's action is still
	 * recorded — "every change is accountable" beats audit silence). Returns
	 * whether it was purged or disabled.
	 */
	async deleteRule(
		identityHash: string,
		id: string,
	): Promise<{ purged: boolean }> {
		const me = this.requireAuthor(identityHash);
		const existing = this.requireRule(id);
		const at = Date.now();
		const purgeable = existing.origin === "custom" && !this.ruleHasFired(id);
		if (purgeable) {
			this.sql.exec(`DELETE FROM rule_versions WHERE rule_id = ?`, id);
			this.sql.exec(`DELETE FROM rules WHERE id = ?`, id);
			this.recordRuleChange(me, "purge", id, at);
			return { purged: true };
		}
		const current = latestVersion(existing);
		if (current.enabled) {
			this.writeRuleVersion(
				this.editedIdentity(existing),
				versionFromDefinition({ ...current, enabled: false }, at),
			);
		}
		this.recordRuleChange(me, "disable", id, at);
		return { purged: false };
	}

	/** The couple's event-type schema set (starter seven + any custom types). */
	async listEventTypes(identityHash: string): Promise<EventType[]> {
		this.requireMember(identityHash);
		return this.eventTypes();
	}

	/**
	 * Adds a custom event type. It is first-class and identical in shape to the
	 * starter seven (handoff §5); the id is reserved-namespace-checked so custom
	 * types can never shadow the `counter_*` sugar.
	 */
	async createEventType(
		identityHash: string,
		definition: unknown,
	): Promise<EventType> {
		this.requireMember(identityHash);
		this.assertLive();
		const parsed = eventTypeSchema.safeParse(definition);
		if (!parsed.success) {
			throw coupleError(
				"BAD_REQUEST",
				parsed.error.issues[0]?.message ?? "invalid event type",
			);
		}
		const type = parsed.data;
		if (isReservedTypeId(type.id)) {
			throw coupleError("CONFLICT", "the counter_ prefix is reserved");
		}
		if (this.eventTypeById(type.id)) {
			throw coupleError(
				"CONFLICT",
				"an event type with that id already exists",
			);
		}
		this.sql.exec(
			`INSERT INTO event_types (id, definition) VALUES (?, ?)`,
			type.id,
			JSON.stringify(type),
		);
		return type;
	}

	// ── Event log (handoff §4.1) ─────────────────────────────────────────────

	/**
	 * Appends an event — the human-authored source of truth. The server assigns
	 * the ULID and `logged_at`; `occurred_at` defaults to `logged_at` but may be
	 * backdated for backfill. Validates the payload against the type schema
	 * (log permission, required subject, metadata kinds and set-permissions),
	 * then applies any direct-manipulation projection. There is deliberately no
	 * update or delete path: the log is append-only.
	 */
	async logEvent(
		identityHash: string,
		input: LogEventInput,
	): Promise<EventView> {
		const me = this.requireMember(identityHash);
		// The `counter_*` types are internal sugar. They must go through
		// adjustCounter/resetCounter, which enforce the counter's own
		// modify_permission and coerce the delta — accepting them on the raw log
		// path would bypass both (a permission-and-integrity hole).
		if (isBuiltinType(input.type)) {
			throw coupleError(
				"FORBIDDEN",
				"counters are changed through the counter endpoints",
			);
		}
		return this.appendEvent(me, input);
	}

	/**
	 * The shared append path: validates against the type schema and writes the
	 * event, then applies any direct-manipulation projection. Callers are
	 * responsible for authorization — the public `logEvent` blocks the internal
	 * counter types, while `adjustCounter`/`resetCounter` gate on the counter's
	 * `modify_permission` before appending their `counter_*` events here.
	 */
	private appendEvent(me: MemberRow, input: LogEventInput): EventView {
		this.assertLive();
		this.assertNotPaused();
		if (this.status() !== "active") {
			throw coupleError("BAD_REQUEST", "roles are not confirmed yet");
		}
		const type = this.eventTypeById(input.type);
		if (!type)
			throw coupleError("BAD_REQUEST", `unknown event type: ${input.type}`);

		const role = me.role as Role | null;
		if (!this.roleAllowed(role, type.log_permission)) {
			throw coupleError("FORBIDDEN", "your role may not log this event type");
		}
		if (type.subject_required && !input.subject) {
			throw coupleError("BAD_REQUEST", "this event type requires a subject");
		}
		this.validateMetadata(
			type,
			input.metadata,
			role,
			this.subjectRole(input.subject),
		);
		// No silent default (ADR 0001): a journaling-capable type must carry an
		// explicit visibility choice, so a private reflection can never fall through
		// to the most-exposed level by omission. A non-journaling type may omit it —
		// it is always `shared` — but may never be set to anything else (a secret
		// infraction would gut the always-shared consent spine).
		if (input.visibility === undefined && type.journaling) {
			throw coupleError(
				"BAD_REQUEST",
				"choose a visibility for this journal entry",
			);
		}
		const visibility = input.visibility ?? "shared";
		if (!visibilityAllowedForType(type, visibility)) {
			throw coupleError(
				"BAD_REQUEST",
				`a ${input.type} event is always shared`,
			);
		}

		const loggedAt = Date.now();
		const event: Event = {
			id: ulid(loggedAt),
			type: input.type,
			actor: me.id,
			subject: input.subject,
			occurred_at: input.occurred_at ?? loggedAt,
			logged_at: loggedAt,
			metadata: input.metadata,
			note: input.note,
			visibility,
		};
		this.sql.exec(
			`INSERT INTO events (id, type, actor, subject, occurred_at, logged_at, metadata, note, visibility)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			event.id,
			event.type,
			event.actor,
			event.subject ?? null,
			event.occurred_at,
			event.logged_at,
			JSON.stringify(event.metadata),
			event.note ?? null,
			event.visibility,
		);

		// Two disjoint projection paths: `counter_*` sugar moves a counter directly;
		// every real event is run through the rule engine (Phase 3). A pending
		// event still fires its unconditional rules and records near-misses for the
		// conditional ones waiting on adjudication (handoff §7). A `secret` entry is
		// inert (ADR 0001): it fires no rules and touches no shared projection or
		// trace row, or its very existence would leak to the partner.
		this.timersDirty = false;
		if (event.visibility !== "secret") {
			this.applyDirectManipulation(event);
			if (!isBuiltinType(event.type)) {
				// No amendments at append time, so composite == the event's own metadata.
				this.applyRules(event, event.metadata, type.awaiting);
			}
		}
		// A rule may have opened or closed a timer, moving the nearest consequence; only
		// then is a re-arm needed. Most events touch no timer, so skip the re-query.
		if (this.timersDirty) this.armAlarm();

		// A freshly-appended event has no amendments yet, so composite == its own
		// metadata; the shape is built the same way it is read back (handoff §4.2).
		return deriveEventView(event, [], type, this.subjectRole(event.subject));
	}

	/**
	 * The event log, newest first, as composite views (handoff §4.6, §9), funnelled
	 * through the viewer's visibility (ADR 0001): a partner's `secret` entries are
	 * omitted entirely, their `sealed` entries appear with the prose redacted, and
	 * everything else (shared entries, the caller's own entries) passes through.
	 */
	async listEvents(identityHash: string, limit = 200): Promise<EventView[]> {
		const me = this.requireMember(identityHash);
		const types = new Map(this.eventTypes().map((t) => [t.id, t]));
		const amendmentsByEvent = this.amendmentsByEvent();
		const views: EventView[] = [];
		for (const row of this.eventRows(limit)) {
			const event = this.rowToEvent(row);
			const view = deriveEventView(
				event,
				amendmentsByEvent.get(event.id) ?? [],
				types.get(event.type),
				this.subjectRole(event.subject),
			);
			const visible = visibleView(view, me.id);
			if (visible) views.push(visible);
		}
		return views;
	}

	// ── Amendments (handoff §4.2) — rulings, notes, retractions ───────────────

	/**
	 * Records an amendment against an event: an `adjudication` (a ruling on the
	 * awaited keys), a `note_appended` (the author annotating their own pending
	 * event), or a `retracted` (the author withdrawing their own pending event).
	 * Events are never mutated or deleted — this only ever *appends* an amendment,
	 * and composite state is re-derived on read. The server owns `id`,
	 * `created_at`, and `actor`; all semantics are gated by `validateAmendment`.
	 */
	async amend(identityHash: string, body: unknown): Promise<EventView> {
		const me = this.requireMember(identityHash);
		this.assertLive();
		this.assertNotPaused();
		if (this.status() !== "active") {
			throw coupleError("BAD_REQUEST", "roles are not confirmed yet");
		}
		const parsed = amendmentInputSchema.safeParse(body);
		if (!parsed.success) {
			throw coupleError(
				"BAD_REQUEST",
				parsed.error.issues[0]?.message ?? "invalid amendment",
			);
		}
		const input = parsed.data;

		const row = this.eventRowById(input.target_event_id);
		if (!row) throw coupleError("NOT_FOUND", "no such event");
		const event = this.rowToEvent(row);
		const type = this.eventTypeById(event.type);
		if (!type)
			throw coupleError("BAD_REQUEST", `unknown event type: ${event.type}`);

		const priorAmendments = this.amendmentsOf(event.id);
		const check = validateAmendment(input, {
			event,
			eventType: type,
			actorRole: me.role as Role | null,
			actorMemberId: me.id,
			amendments: priorAmendments,
			subjectRole: this.subjectRole(event.subject),
		});
		if (!check.ok) {
			throw coupleError(
				check.forbidden ? "FORBIDDEN" : "BAD_REQUEST",
				check.error,
			);
		}

		const amendment = this.writeAmendment(me.id, input);
		const amendments = [...priorAmendments, amendment];

		// A ruling can resolve a conditional rule that was waiting on it (handoff
		// §4.2, §7): re-evaluate the target with the merged metadata and fire the
		// rules that match now but didn't before. Notes, retractions, and responses
		// change no composite state, so only an adjudication re-evaluates.
		if (amendment.kind === "adjudication") {
			this.reevaluateOnAmendment(event, type, priorAmendments, amendment);
		}
		// Funnel the returned view through the actor's visibility (ADR 0001): a dom
		// responding to a *sealed* entry gets back the existence row plus their own
		// response, never the sub's prose. The author always sees their own entry in
		// full. (A `secret` entry is unreachable here — validation refuses it.)
		const view = deriveEventView(
			event,
			amendments,
			type,
			this.subjectRole(event.subject),
		);
		return visibleView(view, me.id) ?? view;
	}

	/**
	 * Applies the effects a ruling newly unlocks on its target event. Effect-only
	 * — an amendment never creates an event (no cascades). Anchor resets carry the
	 * target's `occurred_at`; timer effects apply only while the timer is still
	 * active and otherwise leave a skip note rather than doing retroactive surgery
	 * (handoff §4.2). Every change is traced to the target event, the rule, and
	 * the ruling that unlocked it.
	 */
	private reevaluateOnAmendment(
		event: Event,
		type: EventType,
		priorAmendments: Amendment[],
		amendment: Amendment,
	): void {
		const before = compositeMetadata(event, priorAmendments);
		const after = compositeMetadata(event, [...priorAmendments, amendment]);
		// Effective-dating keys off the target event's log-time, never the ruling
		// time — a late ruling fires the rule version in force when the event was
		// logged, so adjudicating the past can't smuggle in a newer rule (ADR 0002).
		const fired = reevaluate(
			this.rulesAt(event.logged_at),
			this.ruleContext(event, before, type.awaiting),
			this.ruleContext(event, after, type.awaiting),
		);

		this.timersDirty = false;
		for (const rule of fired) {
			for (const op of rule.ops) {
				this.applyEffectOp(event, rule.rule_id, op, amendment);
			}
		}
		if (this.timersDirty) this.armAlarm();
	}

	/** Inserts an amendment, assigning the server-owned id/created_at/actor. */
	private writeAmendment(actor: string, input: AmendmentInput): Amendment {
		const createdAt = Date.now();
		const id = ulid(createdAt);
		const patch =
			input.kind === "adjudication" ? JSON.stringify(input.patch) : null;
		const supersedes =
			input.kind === "adjudication" ? (input.supersedes ?? null) : null;
		const note = "note" in input ? (input.note ?? null) : null;
		this.sql.exec(
			`INSERT INTO amendments (id, target_event_id, kind, actor, created_at, patch, note, supersedes)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.target_event_id,
			input.kind,
			actor,
			createdAt,
			patch,
			note,
			supersedes,
		);
		return this.rowToAmendment({
			id,
			target_event_id: input.target_event_id,
			kind: input.kind,
			actor,
			created_at: createdAt,
			patch,
			note,
			supersedes,
		});
	}

	// ── Counters (handoff §4.4) — materialized cache over the log ─────────────

	/** All counters with their cached values (cheap reads for live sync). */
	async listCounters(identityHash: string): Promise<Counter[]> {
		this.requireMember(identityHash);
		return this.counterRows().map((row) => this.rowToCounter(row));
	}

	/**
	 * Defines a new counter. The value starts at 0 and only moves via events. The
	 * id is derived from the name when the caller doesn't supply one, and
	 * disambiguated against existing counters (so "Good boy!" and "Good boy" don't
	 * collide on the same slug and reject the second create).
	 */
	async createCounter(
		identityHash: string,
		input: CreateCounterInput,
	): Promise<Counter> {
		this.requireMember(identityHash);
		this.assertLive();
		const id = this.uniqueCounterId(input.id ?? slugify(input.name));
		const definition: CounterDefinition = {
			id,
			name: input.name,
			valence: input.valence,
			daily_target: input.daily_target,
			weekly_target: input.weekly_target,
			reset: input.reset,
			modify_permission: input.modify_permission,
		};
		this.sql.exec(
			`INSERT INTO counters (id, definition, value, updated_at) VALUES (?, ?, 0, NULL)`,
			definition.id,
			JSON.stringify(definition),
		);
		return { ...definition, value: 0, updated_at: null };
	}

	/**
	 * The "+1 / −1 tap" (handoff §4.1, §4.4): sugar that appends a
	 * `counter_adjusted` event. The counter never changes out of band — the event
	 * is the cause, and `applyDirectManipulation` folds it into the cache.
	 */
	async adjustCounter(
		identityHash: string,
		counterId: string,
		delta: number,
		note?: string,
	): Promise<Counter> {
		const me = this.requireMember(identityHash);
		const counter = this.requireCounter(counterId);
		this.assertModifyAllowed(me, counter);
		// Integer only — a fractional delta would break counterSchema on read.
		if (!Number.isInteger(delta)) {
			throw coupleError("BAD_REQUEST", "delta must be a whole number");
		}
		this.appendEvent(me, {
			type: COUNTER_ADJUSTED_TYPE,
			metadata: { counter: counterId, delta },
			note,
			visibility: "shared",
		});
		return this.rowToCounter(this.requireCounterRow(counterId));
	}

	/** Resets a counter to 0 via a `counter_reset` event (handoff §4.4). */
	async resetCounter(
		identityHash: string,
		counterId: string,
		note?: string,
	): Promise<Counter> {
		const me = this.requireMember(identityHash);
		const counter = this.requireCounter(counterId);
		this.assertModifyAllowed(me, counter);
		this.appendEvent(me, {
			type: COUNTER_RESET_TYPE,
			metadata: { counter: counterId },
			note,
			visibility: "shared",
		});
		return this.rowToCounter(this.requireCounterRow(counterId));
	}

	/**
	 * Rebuilds the derived state from the immutable log: zeroes every counter,
	 * clears the trace, then replays every event in append order through the *same*
	 * apply-path used live (`applyDirectManipulation` + `applyRules`). Because it
	 * reuses the live code, the rebuilt values and trace match live application by
	 * construction — the proof that the materialized value is only ever a cache
	 * (handoff §4.4) and that every change has a recorded cause (handoff §4.6).
	 *
	 * Semantics: the replay uses the *current* rule set (rules aren't effective-
	 * dated yet), so after a rule is added or edited a rebuild re-derives history
	 * under today's rules and may differ from the incrementally-maintained cache,
	 * which only ever saw the rules in force at each append. That's the intended
	 * meaning of rebuild here; proper per-event rule versioning is a later phase.
	 * Amendments (Phase 5) will fold into the replayed composite metadata.
	 */
	async rebuildCounters(identityHash: string): Promise<Counter[]> {
		this.requireMember(identityHash);
		// Reset every projection cache; all are rebuilt below purely from the log.
		// Stopwatches are torn down (R15/R16 reopen/close them on replay), keeping
		// them an honest cache — an over-max auto-close is re-derived by the next
		// sweep rather than replayed (a system job, not a logged event). Countdowns
		// are dom *commands*, not event-derived, so the log cannot re-derive them:
		// their assignment (and any pause/extend) is durable and survives the
		// rebuild. Only their event-driven close is re-derived, so reset each to
		// running and let replay re-close via R4/R14; `expired` is re-derived by the
		// countdown sweep, mirroring the stopwatch auto-close.
		// Zero the event-derived counters, but preserve streak counters: their value
		// is folded by the alarm at rollover ("target met? +1 : 0"), not by any
		// logged event, so replay cannot re-derive it — like a timer auto-close, it
		// is system-job state carried across the rebuild and advanced by the next
		// rollover, not reconstructed here.
		const defs = this.counterDefinitions();
		const streakIds = new Set(
			defs.filter((def) => def.streak).map((def) => def.id),
		);
		// Daily/weekly counters are cleared by the off-log `scheduled_reset` alarm, not
		// by any logged event. Replaying the whole log would therefore re-add every
		// increment ever recorded and inflate them to lifetime totals. Repair this by
		// replaying the resets alongside the events: whenever a day/week boundary falls
		// between two consecutive appends (or after the last one, up to now) the
		// matching counters are zeroed, so each ends the rebuild holding only its
		// current period's increments — the same value the live cache carries.
		const dailyResetIds = new Set(
			defs.filter((def) => def.reset === "daily").map((def) => def.id),
		);
		const weeklyResetIds = new Set(
			defs.filter((def) => def.reset === "weekly").map((def) => def.id),
		);
		// One set-based zeroing rather than an UPDATE per counter. Streak values are
		// preserved (folded by the alarm, not the log), so exclude them; with no streak
		// counters the NOT IN clause would be empty SQL, so zero everything instead.
		const streakIdList = [...streakIds];
		if (streakIdList.length === 0) {
			this.sql.exec(`UPDATE counters SET value = 0, updated_at = NULL`);
		} else {
			const placeholders = streakIdList.map(() => "?").join(", ");
			this.sql.exec(
				`UPDATE counters SET value = 0, updated_at = NULL WHERE id NOT IN (${placeholders})`,
				...streakIdList,
			);
		}
		this.sql.exec(`DELETE FROM timers WHERE kind = 'stopwatch'`);
		this.sql.exec(
			`UPDATE timers SET status = NULL, closed_at = NULL WHERE kind = 'countdown'`,
		);
		// Anchors are event-derived (reset by R7/R11/R12/R17), so clear them and let
		// replay re-fold each reset. `resetAnchor` is commutative, so the rebuilt
		// value is independent of replay order.
		this.sql.exec(`UPDATE anchors SET since = NULL`);
		this.sql.exec(`DELETE FROM trace`);
		const awaitingByType = new Map(
			this.eventTypes().map((t) => [t.id, t.awaiting]),
		);
		const now = Date.now();
		let cursor: number | null = null;
		for (const row of this.eventRows(undefined, "ASC")) {
			const event = this.rowToEvent(row);
			// Clear any daily/weekly counters whose reset boundary the alarm would have
			// crossed since the previous append, before folding this event in.
			if (cursor !== null) {
				this.replayScheduledResets(
					cursor,
					event.logged_at,
					dailyResetIds,
					weeklyResetIds,
				);
			}
			cursor = event.logged_at;
			this.applyDirectManipulation(event);
			if (!isBuiltinType(event.type)) {
				this.applyRules(
					event,
					event.metadata,
					awaitingByType.get(event.type) ?? [],
				);
			}
		}
		// Resets that fired after the last append (up to now) still cleared the caches.
		if (cursor !== null) {
			this.replayScheduledResets(cursor, now, dailyResetIds, weeklyResetIds);
		}
		// The replay rewrote the open-timer set, so re-arm at the new minimum.
		this.armAlarm();
		return this.counterRows().map((r) => this.rowToCounter(r));
	}

	// ── Trace / transparency (handoff §4.6) ──────────────────────────────────

	/** The causal chain for a counter: every projection change, newest first. */
	async getCounterTrace(
		identityHash: string,
		counterId: string,
	): Promise<CounterTrace> {
		this.requireMember(identityHash);
		const counter = this.requireCounterRow(counterId);
		const rows = this.sql
			.exec<TraceColumnsRow>(
				`SELECT id, at, caused_by_event, caused_by_rule, caused_by_amendment, actor, projection, detail
					FROM trace WHERE projection = ? ORDER BY at DESC, id DESC`,
				`counter:${counterId}`,
			)
			.toArray()
			.map(decodeTraceRow);
		return { counter_id: counterId, value: counter.value, rows };
	}

	/** The projections a single event touched (handoff §4.6, drill-in). */
	async getEventTrace(
		identityHash: string,
		eventId: string,
	): Promise<TraceRow[]> {
		this.requireMember(identityHash);
		return this.sql
			.exec<TraceColumnsRow>(
				`SELECT id, at, caused_by_event, caused_by_rule, caused_by_amendment, actor, projection, detail
					FROM trace WHERE caused_by_event = ? ORDER BY at ASC, id ASC`,
				eventId,
			)
			.toArray()
			.map(decodeTraceRow);
	}

	// ── Support introspection (handoff §3.5, #44) ─────────────────────────────

	/**
	 * The audited answer to "why did this projection change" (handoff §3.5). It
	 * reconstructs the projection's causal chain from the Trace ledger — the same
	 * rows the transparency view reads — and, before returning, appends an
	 * audit-log row for the access. That write is the whole point: reaching a
	 * couple's data through this support hatch always leaves a mark the couple can
	 * read back (`listAuditLog`), so it is transparent relationship data, never a
	 * silent backdoor. There is no global query escape hatch — only a member of
	 * this couple, routed to this DO, can ask, and only about this couple.
	 */
	async introspect(
		identityHash: string,
		projection: string,
	): Promise<IntrospectionResult> {
		const member = this.requireMember(identityHash);
		const rows = this.sql
			.exec<TraceColumnsRow>(
				`SELECT id, at, caused_by_event, caused_by_rule, caused_by_amendment, actor, projection, detail
					FROM trace WHERE projection = ? ORDER BY at DESC, id DESC`,
				projection,
			)
			.toArray()
			.map(decodeTraceRow);
		const explanation = explainProjection(projection, rows);

		const at = Date.now();
		const inserted = this.sql
			.exec<{ id: number }>(
				`INSERT INTO audit_log (at, actor, action, target)
					VALUES (?, ?, 'introspect', ?) RETURNING id`,
				at,
				member.id,
				projection,
			)
			.toArray()[0];
		return {
			explanation,
			audit: {
				id: inserted.id,
				at,
				actor: member.id,
				action: "introspect",
				target: projection,
			},
		};
	}

	/**
	 * The append-only support-access audit log, newest first (handoff §3.5). Every
	 * `introspect` call is recorded here; surfacing it to members is what keeps
	 * support access accountable.
	 */
	async listAuditLog(identityHash: string): Promise<AuditEntry[]> {
		this.requireMember(identityHash);
		return this.sql
			.exec<{
				id: number;
				at: number;
				actor: string;
				action: string;
				target: string | null;
			}>(
				`SELECT id, at, actor, action, target FROM audit_log ORDER BY at DESC, id DESC`,
			)
			.toArray();
	}

	// ── Projection application + validation ──────────────────────────────────

	/**
	 * Applies direct-manipulation events to the counter cache and records a trace
	 * row for the change (handoff §4.6 — every projection change has a cause).
	 * `caused_by_rule` is null: in Phase 2 the event itself is the cause.
	 */
	private applyDirectManipulation(event: Event): void {
		if (
			event.type !== COUNTER_ADJUSTED_TYPE &&
			event.type !== COUNTER_RESET_TYPE
		)
			return;
		const counterId = event.metadata.counter;
		if (typeof counterId !== "string") return;
		const row = this.counterById(counterId);
		if (!row) return; // a reference to a deleted counter is inert.

		const from = row.value;
		const to = applyCounterEvent(from, {
			type: event.type,
			logged_at: event.logged_at,
			id: event.id,
			metadata: event.metadata,
		});
		this.sql.exec(
			`UPDATE counters SET value = ?, updated_at = ? WHERE id = ?`,
			to,
			event.logged_at,
			counterId,
		);
		// The event itself is the cause (direct manipulation, no rule). A reset is
		// `reset`; an adjust is increment/decrement carrying the absolute delta.
		const delta =
			typeof event.metadata.delta === "number" ? event.metadata.delta : 0;
		const change =
			event.type === COUNTER_RESET_TYPE
				? ({ op: "reset", from, to } as const)
				: ({
						op: delta >= 0 ? "increment" : "decrement",
						by: Math.abs(delta),
						from,
						to,
					} as const);
		this.writeTrace(
			traceCounter(directCause(event.id), event.logged_at, counterId, change),
		);
	}

	/**
	 * Runs the rule engine over an event (handoff §4.3, §7): the fired rules'
	 * effects are applied and traced, and every conditional rule waiting on one of
	 * the type's `awaiting` keys leaves a near-miss trace so pending state is
	 * legible (handoff §4.6). Passing `awaiting` keeps routine events (a non-late
	 * ritual, a set-but-wrong value) from filling the trace with noise. Shared by
	 * the append path and `rebuildCounters`; rules never create events, so this
	 * only ever mutates projections — no cascades, no loops.
	 */
	private applyRules(
		event: Event,
		composite: Record<string, MetadataValue>,
		awaiting: AwaitingEntry[],
	): void {
		// Resolve the rules in force at this event's log-time. On a live append that
		// is "now" (today's rules); on a rebuild it is each past event's own
		// log-time, so replay reproduces history rather than re-deriving it under
		// today's rules (ADR 0002).
		const { fired, nearMisses } = evaluateRules(
			this.rulesAt(event.logged_at),
			this.ruleContext(event, composite, awaiting),
		);
		for (const rule of fired) {
			for (const op of rule.ops) {
				this.applyEffectOp(event, rule.rule_id, op);
			}
		}
		for (const nearMiss of nearMisses) {
			this.writeTrace(
				traceNearMiss(ruleCause(event.id, nearMiss.rule_id), event.logged_at, {
					reason: nearMiss.reason,
					awaiting: nearMiss.awaiting,
				}),
			);
		}
	}

	/**
	 * Applies one resolved effect op and records its trace row, attributed to the
	 * rule that fired it. Counter ops move the materialized cache now; anchor,
	 * timer, and notify ops are recorded so the chain shows what the rule routed,
	 * with their projection state machines landing in Phase 4 (timers + alarms).
	 *
	 * When `amendment` is set the op comes from re-evaluation on a ruling (handoff
	 * §4.2, §7) rather than a fresh append: the counter write and trace row are
	 * stamped at the ruling time and tagged with the amendment that unlocked them,
	 * and — because an amendment never does retroactive timer surgery — a timer op
	 * whose instance has already ended records a skip note and mutates nothing.
	 * The append path passes no amendment and stamps at `event.logged_at`. A live
	 * timer op takes the same `openTimer`/`closeTimer` path either way.
	 */
	private applyEffectOp(
		event: Event,
		ruleId: string,
		op: EffectOp,
		amendment?: Amendment,
	): void {
		const at = amendment?.created_at ?? event.logged_at;
		const cause = this.effectCause(event, ruleId, amendment);
		switch (op.kind) {
			case "counter": {
				const row = this.counterById(op.counter);
				if (!row) return; // a reference to a missing counter is inert.
				const from = row.value;
				const to = applyCounterOp(from, op);
				this.sql.exec(
					`UPDATE counters SET value = ?, updated_at = ? WHERE id = ?`,
					to,
					at,
					op.counter,
				);
				this.writeTrace(
					traceCounter(cause, at, op.counter, {
						op: op.op,
						by: op.by,
						from,
						to,
					}),
				);
				return;
			}
			case "anchor": {
				// Fold the reset into the anchor's `since` (handoff §4.2 — anchored to
				// the event's occurred_at, carried on `op.at`, not the log time). A
				// missing anchor row is inert, mirroring the counter path. `resetAnchor`
				// keeps the later timestamp so a backdated amendment can't drag it back.
				const row = this.anchorById(op.anchor);
				if (!row) return;
				const from = row.since;
				const to = resetAnchor(from, op.at);
				this.sql.exec(
					`UPDATE anchors SET since = ? WHERE id = ?`,
					to,
					op.anchor,
				);
				this.writeTrace(
					traceAnchor(cause, at, op.anchor, { at: op.at, from, to }),
				);
				return;
			}
			case "timer":
				// A ruling never performs retroactive timer surgery (handoff §4.2): if
				// no live instance matches, record the skip and mutate nothing. A fresh
				// append has no such guard — its timer op always acts.
				if (
					amendment &&
					!this.matchOpenTimer(this.openTimerRows(op.timer), op.match_on)
				) {
					this.writeTrace(
						traceTimerSkipped(cause, at, op.timer, {
							reason: `${ruleId} skipped: ${op.timer} already ended`,
							op: op.op,
						}),
					);
					return;
				}
				// The open-timer set moved, so the caller (appendEvent/re-eval) re-arms.
				this.timersDirty = true;
				if (op.op === "open") {
					this.openTimer(event, ruleId, op);
				} else {
					this.closeTimer(event, ruleId, op);
				}
				return;
			case "notify":
				this.writeTrace(traceNotify(cause, at, op.target));
				return;
		}
	}

	/**
	 * The typed cause of a rule-driven effect: a plain rule fire on append, or an
	 * amendment when re-evaluation on a ruling unlocked it (handoff §4.2, §7).
	 */
	private effectCause(
		event: Event,
		ruleId: string,
		amendment?: Amendment,
	): TraceCause {
		return amendment
			? amendmentCause(event.id, ruleId, amendment.id)
			: ruleCause(event.id, ruleId);
	}

	/** The one trace sink: encodes the detail and writes the single row. */
	private writeTrace(entry: TraceEntry): void {
		const cols = causeColumns(entry.cause);
		this.sql.exec(
			`INSERT INTO trace (at, caused_by_event, caused_by_rule, caused_by_amendment, actor, projection, detail)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			entry.at,
			cols.caused_by_event,
			cols.caused_by_rule,
			cols.caused_by_amendment,
			cols.actor,
			entry.projection,
			encodeDetail(entry.detail),
		);
	}

	// ── Timers (handoff §4.5) ────────────────────────────────────────────────

	/**
	 * All timers, newest first, as live views for the today screen. The over-max
	 * stopwatch sweep runs first so a session left running past its per-activity
	 * max reads as auto-closed even on a couple that has been dormant — the alarm
	 * (#32) makes this precise, but a read never shows a stale over-max as running.
	 */
	async listTimers(identityHash: string): Promise<TimerView[]> {
		this.requireMember(identityHash);
		const now = Date.now();
		this.sweepOverMaxStopwatches(now);
		this.sweepExpiredCountdowns(now);
		// A sweep may have closed a timer, retiring the consequence the alarm was
		// armed for; re-arm at the new minimum so the single alarm stays honest.
		this.armAlarm();
		return this.timerRows().map((row) => this.rowToTimerView(row));
	}

	/**
	 * Opens a stopwatch (handoff §4.5, R15): records the in-flight instance keyed by
	 * the opening event's ref match (e.g. `session_id`), tagged with its `activity`.
	 * `opened_at` is the event's `occurred_at` so a backfilled session measures the
	 * real elapsed span, not the log time.
	 */
	private openTimer(event: Event, ruleId: string, op: TimerOp): void {
		const id = ulid(event.logged_at);
		// The journal-prompt deadline is the one rule-opened *countdown* (ADR 0001):
		// R19 fires on a `journal_prompt`, and unlike a stopwatch it carries a real
		// deadline (a policy default; the dom can pause/extend it later) and its floor
		// as the tag, so a later close can gate on it. Everything else opens as a
		// stopwatch (R15's `session_stopwatch`).
		if (op.timer === JOURNAL_COUNTDOWN_TIMER) {
			const state: TimerState = {
				match: op.match_on ?? {},
				tag: op.tag,
				deadline_at: event.occurred_at + DEFAULT_JOURNAL_DEADLINE_MS,
			};
			this.sql.exec(
				`INSERT INTO timers (id, kind, definition, state, status, opened_at, closed_at)
					VALUES (?, 'countdown', ?, ?, NULL, ?, NULL)`,
				id,
				op.timer,
				JSON.stringify(state),
				event.occurred_at,
			);
			this.writeTrace(
				traceTimerOpen(ruleCause(event.id, ruleId), event.logged_at, op.timer, {
					timer_id: id,
					match_on: op.match_on,
					tag: op.tag,
				}),
			);
			return;
		}
		const state: TimerState = { match: op.match_on ?? {}, tag: op.tag };
		this.sql.exec(
			`INSERT INTO timers (id, kind, definition, state, status, opened_at, closed_at)
				VALUES (?, 'stopwatch', ?, ?, NULL, ?, NULL)`,
			id,
			op.timer,
			JSON.stringify(state),
			event.occurred_at,
		);
		this.writeTrace(
			traceTimerOpen(ruleCause(event.id, ruleId), event.logged_at, op.timer, {
				timer_id: id,
				match_on: op.match_on,
				tag: op.tag,
			}),
		);
	}

	/**
	 * Closes a timer (handoff §4.5, R16/R4/R14): finds the open instance by the
	 * close event's resolved ref match, derives its duration, and — when the close
	 * routes a duration into a counter (R16 → `service_minutes_week`) — folds that
	 * in via the shared counter path. A close with no matching open is an orphan
	 * (`session_ended` with no `session_started`): rejected with a trace note, never
	 * a wildcard that would close an unrelated session.
	 */
	private closeTimer(event: Event, ruleId: string, op: TimerOp): void {
		const target = this.matchOpenTimer(
			this.openTimerRows(op.timer),
			op.match_on,
		);
		if (!target) {
			// No open timer matched. Before calling this an orphan, check whether the
			// over-max sweep already auto-closed this session — the genuine session_ended
			// then arrives after the fact. That is not an orphan: reconcile it by stamping
			// the real end time on the auto-closed row (so a review sees the true span)
			// and trace it as such. An auto-closed session is flagged for review, not
			// auto-credited (handoff §4.5), so no duration is routed.
			const autoClosed = this.matchOpenTimer(
				this.autoClosedTimerRows(op.timer),
				op.match_on,
			);
			if (autoClosed) {
				const state = this.timerState(autoClosed);
				state.actual_ended_at = event.occurred_at;
				this.sql.exec(
					`UPDATE timers SET state = ? WHERE id = ?`,
					JSON.stringify(state),
					autoClosed.id,
				);
				this.writeTrace(
					traceTimerClose(
						ruleCause(event.id, ruleId),
						event.logged_at,
						op.timer,
						{
							matched: true,
							timer_id: autoClosed.id,
							status: autoClosed.status ?? undefined,
							reconciled_auto_closed: true,
							note: "session already auto-closed past max; recorded actual end for review",
						},
					),
				);
				return;
			}
			this.writeTrace(
				traceTimerClose(
					ruleCause(event.id, ruleId),
					event.logged_at,
					op.timer,
					{
						matched: false,
						match_on: op.match_on,
						note: "no matching open timer",
					},
				),
			);
			return;
		}
		// The journal-prompt deadline only closes when the answering entry clears the
		// prompt's floor (ADR 0001): a below-floor answer (e.g. a sealed reply to a
		// shared-floor prompt) is the sub's right to log, but it does not discharge
		// the assignment — the countdown is left running to expire unmet, and the dom
		// is never told a below-floor entry exists. (A secret answer never reaches
		// here at all: it is inert.)
		if (op.timer === JOURNAL_COUNTDOWN_TIMER) {
			const floor = this.timerState(target).tag as Floor | undefined;
			if (!satisfiesFloor(event.visibility, floor)) {
				this.writeTrace(
					traceTimerSkipped(
						ruleCause(event.id, ruleId),
						event.logged_at,
						op.timer,
						{
							reason: `${ruleId} skipped: answer below the '${floor}' floor`,
							op: op.op,
						},
					),
				);
				return;
			}
		}
		const closedAt = event.occurred_at;
		const durationMs = stopwatchDurationMs(
			target.opened_at ?? closedAt,
			closedAt,
		);
		const state = this.timerState(target);
		state.duration_ms = durationMs;
		this.sql.exec(
			`UPDATE timers SET status = ?, closed_at = ?, state = ? WHERE id = ?`,
			op.status ?? "completed",
			closedAt,
			JSON.stringify(state),
			target.id,
		);
		this.writeTrace(
			traceTimerClose(ruleCause(event.id, ruleId), event.logged_at, op.timer, {
				matched: true,
				timer_id: target.id,
				status: op.status,
				duration_ms: durationMs,
				route_duration_to: op.route_duration_to,
			}),
		);
		// The rule routes the derived duration; the timer computed it (handoff §4.3).
		const routed = routeClosedTimerDuration(op, durationMinutes(durationMs));
		if (routed) this.applyEffectOp(event, ruleId, routed);
	}

	/**
	 * Resolves which open timer a close targets. An undefined match is a singleton
	 * close (R14's `denial_period`, no ref): the oldest open of that definition, or
	 * none. A defined match (even empty) must pin its keys — an empty match is a
	 * close whose ref key was unset, which is an orphan, not a wildcard.
	 */
	private matchOpenTimer(
		rows: TimerRow[],
		matchOn: Record<string, MetadataValue> | undefined,
	): TimerRow | undefined {
		if (matchOn === undefined) return rows[0];
		const matched = matchStopwatch(
			rows.map((r) => this.rowToOpenStopwatch(r)),
			matchOn,
		);
		return matched ? rows.find((r) => r.id === matched.id) : undefined;
	}

	/**
	 * Auto-closes any stopwatch that has run past its per-activity max (handoff
	 * §4.5), flagged for review, attributed to the `system_job` in the trace. Idempotent
	 * and cheap on a dormant couple (a single indexed read). Returns the count closed.
	 */
	private sweepOverMaxStopwatches(now: number): number {
		// Paused (safeword): no auto-close may fire. `opened_at` is shifted forward
		// by the paused span on resume, so the over-max clock never counts the pause.
		if (this.isPaused()) return 0;
		const rows = this.sql
			.exec<TimerRow>(
				`SELECT id, kind, definition, state, status, opened_at, closed_at
					FROM timers WHERE kind = 'stopwatch' AND status IS NULL`,
			)
			.toArray();
		const due = stopwatchesToAutoClose(
			rows.map((r) => this.rowToOpenStopwatch(r)),
			now,
			STOPWATCH_MAX_MS_BY_ACTIVITY,
			DEFAULT_STOPWATCH_MAX_MS,
		);
		let closed = 0;
		for (const inst of due) {
			const closedSw = closeStopwatch(inst, now, { auto: true });
			const row = rows.find((r) => r.id === inst.id);
			if (!row) continue;
			const state = this.timerState(row);
			state.duration_ms = closedSw.duration_ms;
			this.sql.exec(
				`UPDATE timers SET status = 'auto_closed', closed_at = ?, state = ? WHERE id = ?`,
				now,
				JSON.stringify(state),
				row.id,
			);
			this.writeTrace(
				traceAutoClose(now, row.definition, {
					flagged_for_review: true,
					timer_id: row.id,
					duration_ms: closedSw.duration_ms,
				}),
			);
			closed++;
		}
		return closed;
	}

	// ── Countdowns (dom-assigned deadline timers) — handoff §4.5, #30 ─────────

	/**
	 * Assigns a countdown (handoff §4.5 — "dom-started countdown = assignment").
	 * Unlike a stopwatch (opened by a `session_started` event via R15), a countdown
	 * is a direct dom command: it has no opening event, so it is durable state that
	 * a `rebuildCounters` replay preserves rather than re-derives. Its close *is*
	 * event-driven (R4 `task_completed`, R14 `orgasm permitted=false`), and its
	 * `expired` disposition comes from the alarm sweep. `session_stopwatch` is
	 * reserved for the stopwatch flavor and cannot be assigned as a countdown —
	 * R16 would otherwise try to close it by `session_id` and route a duration.
	 */
	async assignCountdown(
		identityHash: string,
		input: unknown,
	): Promise<TimerView> {
		const me = this.requireMember(identityHash);
		this.assertDom(me);
		this.assertNotPaused();
		const parsed = assignCountdownInputSchema.parse(input);
		if (this.stopwatchDefinitionNames().has(parsed.timer)) {
			throw coupleError(
				"BAD_REQUEST",
				`${parsed.timer} is reserved for stopwatches`,
			);
		}
		const now = Date.now();
		const id = ulid(now);
		const state: TimerState = {
			match: parsed.match,
			tag: parsed.tag,
			deadline_at: now + parsed.duration_ms,
		};
		this.sql.exec(
			`INSERT INTO timers (id, kind, definition, state, status, opened_at, closed_at)
				VALUES (?, 'countdown', ?, ?, NULL, ?, NULL)`,
			id,
			parsed.timer,
			JSON.stringify(state),
			now,
		);
		this.writeTrace(
			traceTimerCommand(me.id, now, parsed.timer, {
				command: "assign",
				timer_id: id,
				match: parsed.match,
				tag: parsed.tag,
				deadline_at: state.deadline_at,
			}),
		);
		this.armAlarm();
		return this.rowToTimerView(this.requireTimerRow(id));
	}

	/**
	 * Pauses a running countdown, freezing the time that was left (handoff §4.5 —
	 * "pause and extend by the dom are day-one features"). A paused countdown never
	 * expires; that is exactly the "life intruded" escape valve.
	 */
	async pauseTimer(identityHash: string, timerId: string): Promise<TimerView> {
		const me = this.requireMember(identityHash);
		this.assertDom(me);
		this.assertNotPaused();
		const now = Date.now();
		// A countdown whose deadline has already passed but hasn't been swept yet must
		// not be paused: pauseCountdown would freeze remaining_ms at 0, and because the
		// expiry sweep skips paused countdowns the timer could then never be marked
		// `expired` — it would linger open forever and the future-consequence hook for
		// the missed deadline would never fire. Sweep first so an overdue countdown is
		// expired here, and requireOpenCountdown then rejects it as already closed.
		if (this.sweepExpiredCountdowns(now) > 0) this.armAlarm();
		const row = this.requireOpenCountdown(timerId);
		if (this.timerState(row).paused_at != null) {
			throw coupleError("BAD_REQUEST", "countdown is already paused");
		}
		const patch = pauseCountdown(this.rowToCountdown(row), now);
		this.patchTimerState(row, patch);
		this.writeTrace(
			traceTimerCommand(me.id, now, row.definition, {
				command: "pause",
				timer_id: row.id,
				remaining_ms: patch.remaining_ms,
			}),
		);
		this.armAlarm();
		return this.rowToTimerView(this.requireTimerRow(row.id));
	}

	/**
	 * Resumes a paused countdown, re-projecting the frozen remaining time onto a
	 * fresh deadline so the pause added no cost and stole no time (handoff §4.5).
	 */
	async resumeTimer(identityHash: string, timerId: string): Promise<TimerView> {
		const me = this.requireMember(identityHash);
		this.assertDom(me);
		this.assertNotPaused();
		const row = this.requireOpenCountdown(timerId);
		if (this.timerState(row).paused_at == null) {
			throw coupleError("BAD_REQUEST", "countdown is not paused");
		}
		const now = Date.now();
		const patch = resumeCountdown(this.rowToCountdown(row), now);
		this.patchTimerState(row, patch);
		this.writeTrace(
			traceTimerCommand(me.id, now, row.definition, {
				command: "resume",
				timer_id: row.id,
				deadline_at: patch.deadline_at,
			}),
		);
		this.armAlarm();
		return this.rowToTimerView(this.requireTimerRow(row.id));
	}

	/**
	 * Extends a countdown by the granted time (handoff §4.5). While running the
	 * deadline moves out; while paused the frozen remaining grows, re-projected
	 * onto a deadline on resume.
	 */
	async extendTimer(
		identityHash: string,
		timerId: string,
		input: unknown,
	): Promise<TimerView> {
		const me = this.requireMember(identityHash);
		this.assertDom(me);
		this.assertNotPaused();
		const row = this.requireOpenCountdown(timerId);
		const { by_ms } = extendTimerInputSchema.parse(input);
		const now = Date.now();
		const patch = extendCountdown(this.rowToCountdown(row), by_ms);
		this.patchTimerState(row, patch);
		this.writeTrace(
			traceTimerCommand(me.id, now, row.definition, {
				command: "extend",
				timer_id: row.id,
				by_ms,
				...patch,
			}),
		);
		this.armAlarm();
		return this.rowToTimerView(this.requireTimerRow(row.id));
	}

	/**
	 * Expires any running countdown past its deadline (handoff §4.5 — the future-
	 * consequence hook), marked `expired`, attributed to the `system_job`. Like the
	 * over-max stopwatch sweep this is idempotent and re-derived on read; the alarm
	 * (#32) makes it precise, but a read never shows a stale running countdown as
	 * live. A paused countdown is skipped — its clock is frozen.
	 */
	private sweepExpiredCountdowns(now: number): number {
		// Paused (safeword): no consequence may fire, even on a read. The paused
		// span is reprojected out of every deadline on resume, so nothing is lost.
		if (this.isPaused()) return 0;
		const rows = this.sql
			.exec<TimerRow>(
				`SELECT id, kind, definition, state, status, opened_at, closed_at
					FROM timers WHERE kind = 'countdown' AND status IS NULL`,
			)
			.toArray();
		let expired = 0;
		for (const row of rows) {
			if (!isCountdownExpired(this.rowToCountdown(row), now)) continue;
			this.sql.exec(
				`UPDATE timers SET status = 'expired', closed_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			this.writeTrace(traceExpire(now, row.definition, { timer_id: row.id }));
			expired++;
		}
		return expired;
	}

	/**
	 * The timer names any installed rule opens as a stopwatch. A countdown may not be
	 * assigned under one of these: stopwatches and countdowns share the close matcher
	 * (openTimerRows keys on definition + `status IS NULL`, not kind), so a countdown
	 * sharing a stopwatch's name could be matched and closed by that stopwatch's rule
	 * and route a bogus duration. Generalizes the former `session_stopwatch` reservation
	 * to whatever the rules actually open.
	 */
	private stopwatchDefinitionNames(): Set<string> {
		const names = new Set<string>();
		for (const rule of this.currentRules()) {
			for (const effect of rule.effects) {
				if (effect.verb === "open_timer") names.add(effect.timer);
			}
		}
		return names;
	}

	private openTimerRows(definition: string): TimerRow[] {
		return this.sql
			.exec<TimerRow>(
				`SELECT id, kind, definition, state, status, opened_at, closed_at
					FROM timers WHERE definition = ? AND status IS NULL
					ORDER BY opened_at ASC, id ASC`,
				definition,
			)
			.toArray();
	}

	/**
	 * The stopwatches of a definition already auto-closed by the over-max sweep, so a
	 * genuine `session_ended` arriving after the sweep can be reconciled against the
	 * session it belongs to (handoff §4.5) rather than dropped as an orphan.
	 */
	private autoClosedTimerRows(definition: string): TimerRow[] {
		return this.sql
			.exec<TimerRow>(
				`SELECT id, kind, definition, state, status, opened_at, closed_at
					FROM timers WHERE definition = ? AND status = 'auto_closed'
					ORDER BY opened_at ASC, id ASC`,
				definition,
			)
			.toArray();
	}

	private timerRows(): TimerRow[] {
		return this.sql
			.exec<TimerRow>(
				`SELECT id, kind, definition, state, status, opened_at, closed_at
					FROM timers ORDER BY opened_at DESC, id DESC`,
			)
			.toArray();
	}

	private timerState(row: TimerRow): TimerState {
		return JSON.parse(row.state) as TimerState;
	}

	private rowToOpenStopwatch(row: TimerRow): OpenStopwatch {
		const state = this.timerState(row);
		return {
			id: row.id,
			timer: row.definition,
			match: state.match ?? {},
			opened_at: row.opened_at ?? 0,
			tag: state.tag,
		};
	}

	private rowToCountdown(row: TimerRow): Countdown {
		const state = this.timerState(row);
		const opened_at = row.opened_at ?? 0;
		return {
			opened_at,
			deadline_at: state.deadline_at ?? opened_at,
			paused_at: state.paused_at ?? null,
			remaining_ms: state.remaining_ms ?? null,
		};
	}

	private timerRowById(id: string): TimerRow | undefined {
		return this.sql
			.exec<TimerRow>(
				`SELECT id, kind, definition, state, status, opened_at, closed_at
					FROM timers WHERE id = ?`,
				id,
			)
			.toArray()[0];
	}

	private requireTimerRow(id: string): TimerRow {
		const row = this.timerRowById(id);
		if (!row) throw coupleError("NOT_FOUND", "no such timer");
		return row;
	}

	private requireOpenCountdown(timerId: string): TimerRow {
		const row = this.timerRowById(timerId);
		if (!row || row.kind !== "countdown") {
			throw coupleError("NOT_FOUND", "no such countdown");
		}
		if (row.status !== null) {
			throw coupleError("BAD_REQUEST", "countdown is already closed");
		}
		return row;
	}

	/**
	 * Merges a countdown transition (from the pure `pauseCountdown`/`resumeCountdown`/
	 * `extendCountdown`) into a timer's stored state. A `null` in the patch clears the
	 * key (resume drops `paused_at`/`remaining_ms`), keeping the stored JSON clean.
	 */
	private patchTimerState(
		row: TimerRow,
		patch: Record<string, number | null>,
	): void {
		const state = this.timerState(row) as Record<string, unknown>;
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete state[key];
			else state[key] = value;
		}
		this.sql.exec(
			`UPDATE timers SET state = ? WHERE id = ?`,
			JSON.stringify(state),
			row.id,
		);
	}

	private rowToTimerView(row: TimerRow): TimerView {
		const state = this.timerState(row);
		return {
			id: row.id,
			kind: row.kind as TimerView["kind"],
			timer: row.definition,
			tag: state.tag ?? null,
			match: state.match ?? {},
			opened_at: row.opened_at,
			closed_at: row.closed_at,
			status: row.status,
			duration_ms: state.duration_ms ?? null,
			deadline_at: state.deadline_at ?? null,
			paused_at: state.paused_at ?? null,
			remaining_ms: state.remaining_ms ?? null,
		};
	}

	// ── Elapsed-since anchors (handoff §4.5, #31) ─────────────────────────────

	/**
	 * The couple's anchors as live views for the today screen (handoff §4.5). Each
	 * carries its `since` timestamp plus a read-time elapsed snapshot; the client
	 * ticks the "days since" display forward against `since` between reads. Resets
	 * are event-driven (R7/R11/R12/R17), so this is a pure read.
	 */
	async listAnchors(identityHash: string): Promise<AnchorView[]> {
		this.requireMember(identityHash);
		const now = Date.now();
		return this.anchorRows().map((row) => {
			const elapsed_ms = anchorElapsedMs(row.since, now);
			return {
				anchor: row.id,
				since: row.since,
				elapsed_ms,
				elapsed_days: anchorElapsedDays(elapsed_ms),
			};
		});
	}

	private anchorRows(): AnchorRow[] {
		return this.sql
			.exec<AnchorRow>(`SELECT id, since FROM anchors ORDER BY id ASC`)
			.toArray();
	}

	private anchorById(id: string): AnchorRow | undefined {
		return this.sql
			.exec<AnchorRow>(`SELECT id, since FROM anchors WHERE id = ?`, id)
			.toArray()[0];
	}

	/**
	 * Validates event metadata against the type schema: no unknown keys, required
	 * keys present, each value the right kind and within bounds, and the actor's
	 * role permitted to set each key (handoff §5). `awaiting` keys *in force for
	 * the event's subject* (ADR 0003) may be left unset — that is what makes the
	 * event pending; a required key whose awaiting entry doesn't apply to this
	 * subject must be supplied like any other required key.
	 */
	private validateMetadata(
		type: EventType,
		metadata: Record<string, MetadataValue>,
		role: Role | null,
		subjectRole: Role | undefined,
	): void {
		for (const key of Object.keys(metadata)) {
			if (!type.metadata[key]) {
				throw coupleError("BAD_REQUEST", `unknown metadata key: ${key}`);
			}
		}
		const awaited = new Set(awaitingKeysFor(type.awaiting, subjectRole));
		for (const [key, field] of Object.entries(type.metadata)) {
			const value = metadata[key];
			if (value === undefined) {
				if (field.required && !awaited.has(key)) {
					throw coupleError("BAD_REQUEST", `missing required metadata: ${key}`);
				}
				continue;
			}
			if (!this.roleAllowed(role, field.set_permission)) {
				throw coupleError("FORBIDDEN", `your role may not set: ${key}`);
			}
			this.checkMetadataValue(key, field, value);
		}
	}

	private checkMetadataValue(
		key: string,
		field: EventType["metadata"][string],
		value: MetadataValue,
	): void {
		switch (field.kind) {
			case "boolean":
				if (typeof value !== "boolean")
					throw coupleError("BAD_REQUEST", `${key} must be a boolean`);
				break;
			case "number":
				if (typeof value !== "number")
					throw coupleError("BAD_REQUEST", `${key} must be a number`);
				if (field.min !== undefined && value < field.min)
					throw coupleError("BAD_REQUEST", `${key} below minimum`);
				if (field.max !== undefined && value > field.max)
					throw coupleError("BAD_REQUEST", `${key} above maximum`);
				break;
			case "enum":
				if (typeof value !== "string" || !field.options.includes(value))
					throw coupleError("BAD_REQUEST", `${key} is not an allowed option`);
				break;
			case "ref":
				if (typeof value !== "string")
					throw coupleError("BAD_REQUEST", `${key} must be a reference`);
				break;
		}
	}

	private roleAllowed(role: Role | null, permitted: Role[]): boolean {
		return role !== null && permitted.includes(role);
	}

	/**
	 * Gates a dom-only command (countdown assign/pause/resume/extend — handoff §4.5,
	 * §5: "dom-started countdown = assignment"). Requires a confirmed, active dynamic
	 * and the actor in the `dom` role; a sub self-reporting cannot assign consequences.
	 */
	private assertDom(member: MemberRow): void {
		this.assertLive();
		if (this.status() !== "active") {
			throw coupleError("BAD_REQUEST", "roles are not confirmed yet");
		}
		if ((member.role as Role | null) !== "dom") {
			throw coupleError("FORBIDDEN", "only the dom may manage countdowns");
		}
	}

	private assertModifyAllowed(
		member: MemberRow,
		counter: CounterDefinition,
	): void {
		this.assertLive();
		if (this.status() !== "active") {
			throw coupleError("BAD_REQUEST", "roles are not confirmed yet");
		}
		const role = member.role as Role | null;
		if (!this.roleAllowed(role, counter.modify_permission)) {
			throw coupleError("FORBIDDEN", "your role may not modify this counter");
		}
	}

	// ── Event / counter SQL helpers ──────────────────────────────────────────

	private eventTypes(): EventType[] {
		return this.sql
			.exec<{ definition: string }>(`SELECT definition FROM event_types`)
			.toArray()
			.map((r) => JSON.parse(r.definition) as EventType);
	}

	private eventTypeById(id: string): EventType | undefined {
		const row = this.sql
			.exec<{ definition: string }>(
				`SELECT definition FROM event_types WHERE id = ?`,
				id,
			)
			.toArray()[0];
		return row ? (JSON.parse(row.definition) as EventType) : undefined;
	}

	private eventRows(
		limit?: number,
		order: "ASC" | "DESC" = "DESC",
	): EventRow[] {
		const clause = limit === undefined ? "" : ` LIMIT ${Math.max(0, limit)}`;
		return this.sql
			.exec<EventRow>(
				`SELECT id, type, actor, subject, occurred_at, logged_at, metadata, note, visibility
					FROM events ORDER BY logged_at ${order}, id ${order}${clause}`,
			)
			.toArray();
	}

	private rowToEvent(row: EventRow): Event {
		return {
			id: row.id,
			type: row.type,
			actor: row.actor,
			subject: row.subject ?? undefined,
			occurred_at: row.occurred_at,
			logged_at: row.logged_at,
			metadata: JSON.parse(row.metadata) as Record<string, MetadataValue>,
			note: row.note ?? undefined,
			visibility: row.visibility as Visibility,
		};
	}

	private eventRowById(id: string): EventRow | undefined {
		return this.sql
			.exec<EventRow>(
				`SELECT id, type, actor, subject, occurred_at, logged_at, metadata, note, visibility
					FROM events WHERE id = ?`,
				id,
			)
			.toArray()[0];
	}

	/** An event's amendments in `created_at` order (the composite-fold order). */
	private amendmentsOf(eventId: string): Amendment[] {
		return this.sql
			.exec<AmendmentRow>(
				`SELECT id, target_event_id, kind, actor, created_at, patch, note, supersedes
					FROM amendments WHERE target_event_id = ? ORDER BY created_at ASC, id ASC`,
				eventId,
			)
			.toArray()
			.map((row) => this.rowToAmendment(row));
	}

	private rowToAmendment(row: AmendmentRow): Amendment {
		const base = {
			id: row.id,
			target_event_id: row.target_event_id,
			actor: row.actor,
			created_at: row.created_at,
		};
		switch (row.kind) {
			case "adjudication":
				return {
					kind: "adjudication",
					...base,
					patch: JSON.parse(row.patch ?? "{}") as Record<string, MetadataValue>,
					note: row.note ?? undefined,
					supersedes: row.supersedes ?? undefined,
				};
			case "note_appended":
				return { kind: "note_appended", ...base, note: row.note ?? "" };
			case "response":
				return { kind: "response", ...base, note: row.note ?? "" };
			default:
				return { kind: "retracted", ...base, note: row.note ?? undefined };
		}
	}

	/**
	 * Every event's amendments in one query, grouped by target and kept in
	 * `created_at` order — so `listEvents` folds the whole log's composite state
	 * without a per-event round trip.
	 */
	private amendmentsByEvent(): Map<string, Amendment[]> {
		const byEvent = new Map<string, Amendment[]>();
		for (const row of this.sql
			.exec<AmendmentRow>(
				`SELECT id, target_event_id, kind, actor, created_at, patch, note, supersedes
					FROM amendments ORDER BY created_at ASC, id ASC`,
			)
			.toArray()) {
			const list = byEvent.get(row.target_event_id) ?? [];
			list.push(this.rowToAmendment(row));
			byEvent.set(row.target_event_id, list);
		}
		return byEvent;
	}

	private counterRows(): CounterRow[] {
		return this.sql
			.exec<CounterRow>(
				`SELECT id, definition, value, updated_at FROM counters ORDER BY id`,
			)
			.toArray();
	}

	/**
	 * The installed rules with their full effective-dated version history (#64,
	 * ADR 0002), ordered by id so evaluation is deterministic (matters for
	 * replay/rebuild) and each rule's versions ascending by `effective_from`. Each
	 * version's `enabled` column overrides the definition JSON, so toggling a rule
	 * never rewrites a body.
	 */
	private versionedRules(): VersionedRule[] {
		const versionsByRule = new Map<string, RuleVersion[]>();
		for (const row of this.sql
			.exec<RuleVersionRow>(
				`SELECT rule_id, effective_from, definition, enabled FROM rule_versions
					ORDER BY rule_id, effective_from`,
			)
			.toArray()) {
			const def = JSON.parse(row.definition) as RuleDefinition;
			const list = versionsByRule.get(row.rule_id) ?? [];
			list.push({
				effective_from: row.effective_from,
				condition: def.condition,
				effects: def.effects,
				enabled: row.enabled === 1,
			});
			versionsByRule.set(row.rule_id, list);
		}
		return this.sql
			.exec<RuleIdentityRow>(
				`SELECT id, origin, adopted, upstream_changed FROM rules ORDER BY id`,
			)
			.toArray()
			.map((row) => ({
				id: row.id,
				origin: row.origin as RuleOrigin,
				adopted: row.adopted === 1,
				upstream_changed: row.upstream_changed === 1,
				versions: versionsByRule.get(row.id) ?? [],
			}))
			.filter((rule) => rule.versions.length > 0);
	}

	/** The flat rule set in force at a log-time — what the engine reads (#64). */
	private rulesAt(logTime: number): Rule[] {
		return rulesEffectiveAt(this.versionedRules(), logTime);
	}

	/**
	 * The current flat rule set — the latest version of every rule, including
	 * disabled ones (enabled:false). Used for export and the client preview seam;
	 * `MAX_SAFE_INTEGER` is a log-time past every `effective_from`.
	 */
	private currentRules(): Rule[] {
		return this.rulesAt(Number.MAX_SAFE_INTEGER);
	}

	private ruleIdentity(id: string): RuleIdentityRow | undefined {
		return this.sql
			.exec<RuleIdentityRow>(
				`SELECT id, origin, adopted, upstream_changed FROM rules WHERE id = ?`,
				id,
			)
			.toArray()[0];
	}

	private versionedRuleById(id: string): VersionedRule | undefined {
		return this.versionedRules().find((rule) => rule.id === id);
	}

	/**
	 * Writes a rule's identity row and appends one effective-dated version — the
	 * single write path for every authoring op (create/edit/enable/disable) and for
	 * pack seeding, so the identity-row mirror (`definition`/`enabled`) never drifts
	 * from the newest version in `rule_versions`. Callers stamp `effective_from`
	 * with the current log-time so replay picks the right version per event.
	 *
	 * Nothing in post-v8 code reads the mirror — it is kept in step deliberately,
	 * not speculatively: pre-versioning code reads the whole engine's rules from
	 * `rules.definition`/`enabled`, so a maintained mirror keeps a rollback to that
	 * code (and the v8 backfill it would re-run from) correct instead of stale.
	 */
	private writeRuleVersion(identity: RuleIdentity, version: RuleVersion): void {
		const definition = JSON.stringify({
			condition: version.condition,
			effects: version.effects,
		});
		const enabled = version.enabled ? 1 : 0;
		this.sql.exec(
			`INSERT INTO rules (id, definition, enabled, origin, adopted)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					definition = excluded.definition,
					enabled = excluded.enabled,
					origin = excluded.origin,
					adopted = excluded.adopted`,
			identity.id,
			definition,
			enabled,
			identity.origin,
			identity.adopted ? 1 : 0,
		);
		this.sql.exec(
			`INSERT INTO rule_versions (rule_id, effective_from, definition, enabled)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(rule_id, effective_from) DO UPDATE SET
					definition = excluded.definition,
					enabled = excluded.enabled`,
			identity.id,
			version.effective_from,
			definition,
			enabled,
		);
	}

	/**
	 * Gates a rule-authoring op (create/edit/enable/disable/purge — #64, ADR 0002)
	 * to `role ∈ {dom, switch}` on a confirmed, active dynamic. Viewing is open to
	 * any member (see {@link listRules}/{@link listRuleHistory}); only shaping the
	 * automation that binds the sub is restricted, so it can't be quietly rewritten
	 * by the sub — a switch authors just as a dom does.
	 */
	private requireAuthor(identityHash: string): MemberRow {
		const me = this.requireMember(identityHash);
		this.assertLive();
		if (this.status() !== "active") {
			throw coupleError("BAD_REQUEST", "roles are not confirmed yet");
		}
		const role = me.role as Role | null;
		if (role !== "dom" && role !== "switch") {
			throw coupleError("FORBIDDEN", "only a dom or switch may change rules");
		}
		return me;
	}

	/**
	 * Parses an authoring payload (a full flat rule on create, a bare definition
	 * on edit) against its schema, turning the first issue into a client-facing
	 * BAD_REQUEST.
	 */
	private parseRulePayload<T>(schema: ZodType<T>, input: unknown): T {
		const parsed = schema.safeParse(input);
		if (!parsed.success) {
			throw coupleError(
				"BAD_REQUEST",
				parsed.error.issues[0]?.message ?? "invalid rule",
			);
		}
		return parsed.data;
	}

	private requireRule(id: string): VersionedRule {
		const rule = this.versionedRuleById(id);
		if (!rule) throw coupleError("NOT_FOUND", "no such rule");
		return rule;
	}

	/**
	 * The identity row after an authoring write: editing or toggling a pack rule
	 * adopts it (freezes it against pack bumps, ADR 0002).
	 */
	private editedIdentity(rule: VersionedRule): RuleIdentity {
		return {
			id: rule.id,
			origin: rule.origin,
			adopted: rule.origin === "pack" ? true : rule.adopted,
		};
	}

	/**
	 * Rejects conditioning on the internal `counter_*` sugar: those events move
	 * counters via direct manipulation and never reach the engine, so such a rule
	 * could never fire. Caught at author time rather than silently skipping forever.
	 */
	private assertRuleFireable(rule: Rule): void {
		if (isReservedTypeId(rule.condition.type)) {
			throw coupleError(
				"BAD_REQUEST",
				"rules cannot condition on the reserved counter_ types",
			);
		}
	}

	/** The projections and event types a rule may reference, for validation. */
	private ruleValidationCtx() {
		return {
			eventTypes: new Map(this.eventTypes().map((t) => [t.id, t])),
			counters: new Set(this.counterRows().map((r) => r.id)),
			anchors: new Set(DEFAULT_ANCHORS),
			timers: new Set(DEFAULT_TIMERS),
		};
	}

	/** Whether a rule has ever fired (or been traced) — a trace references it. */
	private ruleHasFired(id: string): boolean {
		return (
			this.sql
				.exec<{ n: number }>(
					`SELECT 1 AS n FROM trace WHERE caused_by_rule = ? LIMIT 1`,
					id,
				)
				.toArray().length > 0
		);
	}

	// ── Rule-change audit + partner notice (#64, ADR 0002) ────────────────────

	/**
	 * Records a rule change to the `audit_log` (actor, action, target rule) and
	 * bumps the couple's rule-change sequence so the *partner* — the member who did
	 * not make the change — sees an in-app notice. Rule changes never write to the
	 * event log: they are configuration, not part of the append-only record of what
	 * happened. Transparency (audit + notice) stands in for a consent handshake, so
	 * dom/switch-only authoring stays visible to the sub bound by the rules.
	 */
	private recordRuleChange(
		actor: MemberRow,
		kind: RuleChangeKind,
		ruleId: string,
		at: number,
	): void {
		this.sql.exec(
			`INSERT INTO audit_log (at, actor, action, target) VALUES (?, ?, ?, ?)`,
			at,
			actor.id,
			ruleChangeAction(kind),
			ruleId,
		);
	}

	/** A member's count of rule changes made by their partner since they last looked. */
	private ruleChangesUnseen(memberId: string): number {
		const seen = Number(this.getSetting(`rules_seen_at_${memberId}`) ?? "0");
		const row = this.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM audit_log
					WHERE action LIKE ? AND actor != ? AND at > ?`,
				`${RULE_CHANGE_ACTION_PREFIX}%`,
				memberId,
				seen,
			)
			.toArray()[0];
		return row?.n ?? 0;
	}

	/** Marks the caller's rule-change notices seen — opening the rules screen acks. */
	private markRuleChangesSeen(memberId: string): void {
		this.setSetting(`rules_seen_at_${memberId}`, String(Date.now()));
	}

	private counterById(id: string): CounterRow | undefined {
		return this.sql
			.exec<CounterRow>(
				`SELECT id, definition, value, updated_at FROM counters WHERE id = ?`,
				id,
			)
			.toArray()[0];
	}

	/** A free counter id from a slug base, suffixing `_2`, `_3`… on collision. */
	private uniqueCounterId(base: string): string {
		if (!base) throw coupleError("BAD_REQUEST", "counter name is required");
		if (!this.counterById(base)) return base;
		for (let n = 2; ; n++) {
			const candidate = `${base}_${n}`;
			if (!this.counterById(candidate)) return candidate;
		}
	}

	private requireCounterRow(id: string): CounterRow {
		const row = this.counterById(id);
		if (!row) throw coupleError("NOT_FOUND", "no such counter");
		return row;
	}

	private requireCounter(id: string): CounterDefinition {
		return JSON.parse(
			this.requireCounterRow(id).definition,
		) as CounterDefinition;
	}

	private rowToCounter(row: CounterRow): Counter {
		const def = JSON.parse(row.definition) as CounterDefinition;
		return { ...def, value: row.value, updated_at: row.updated_at };
	}

	// ── SQL helpers ──────────────────────────────────────────────────────────

	protected devicesOf(memberId: string): DeviceRow[] {
		return this.sql
			.exec<DeviceRow>(
				`SELECT device_id, token_hash, label, created_at, revoked_at
					FROM devices WHERE member_id = ? ORDER BY created_at`,
				memberId,
			)
			.toArray();
	}

	protected members(): MemberRow[] {
		return this.sql
			.exec<MemberRow>(`SELECT id, identity_hash, role, joined_at FROM members`)
			.toArray();
	}

	/**
	 * The role an event's subject resolves to (ADR 0003), via the shared
	 * `resolveSubjectRole` seam — the engine itself stays member-id-free. Roles
	 * are fixed after mutual confirmation, so resolving at replay time yields the
	 * same role as at append time and a rebuild reproduces history.
	 */
	protected subjectRole(subject: string | undefined): Role | undefined {
		return resolveSubjectRole(
			subject,
			(memberId) =>
				this.members().find((m) => m.id === memberId)?.role as Role | null,
		);
	}

	/**
	 * The engine context for one snapshot of an event's metadata (ADR 0003): the
	 * subject role resolves once and scopes both the qualified rules and the
	 * awaiting keys in force. The single place a `RuleEventContext` is built from
	 * an event, so the append, rebuild, and re-adjudication paths can never drift
	 * on how a subject or an awaiting entry gates evaluation — the lockstep
	 * {@link awaitingKeysFor} exists to guarantee.
	 */
	private ruleContext(
		event: Pick<Event, "type" | "occurred_at" | "subject">,
		metadata: Record<string, MetadataValue>,
		awaiting: AwaitingEntry[],
	): RuleEventContext {
		const subjectRole = this.subjectRole(event.subject);
		return {
			type: event.type,
			metadata,
			occurred_at: event.occurred_at,
			subject_role: subjectRole,
			awaiting: awaitingKeysFor(awaiting, subjectRole),
		};
	}

	protected memberByIdentity(identityHash: string): MemberRow | undefined {
		return this.sql
			.exec<MemberRow>(
				`SELECT id, identity_hash, role, joined_at FROM members WHERE identity_hash = ?`,
				identityHash,
			)
			.toArray()[0];
	}

	protected status(): CoupleStatus {
		return (this.getSetting("status") as CoupleStatus | undefined) ?? "pairing";
	}

	protected getSetting(key: string): string | undefined {
		return this.sql
			.exec<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key)
			.toArray()[0]?.value;
	}

	protected setSetting(key: string, value: string): void {
		this.sql.exec(
			`INSERT INTO settings (key, value) VALUES (?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key,
			value,
		);
	}

	// ── WebSocket + alarms ───────────────────────────────────────────────────

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") === "websocket") {
			return this.acceptSocket();
		}
		// Placeholder command surface; Phase 1+ routes real commands here.
		return new Response("CoupleDO OK", { status: 200 });
	}

	/** Upgrades to a hibernatable WebSocket held open for live sync. */
	private acceptSocket(): Response {
		const { 0: client, 1: server } = new WebSocketPair();
		// Hibernation API: the runtime can evict the DO from memory while the
		// socket stays open, so two long-idle connections per couple cost ~nothing.
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		// Phase 0 skeleton: reply so the socket path is verifiable end to end.
		// Real client/server protocol handling arrives with live projections.
		void message;
		ws.send(JSON.stringify({ type: "pong" }));
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		ws.close(code, reason);
	}

	override async webSocketError(
		_ws: WebSocket,
		_error: unknown,
	): Promise<void> {
		// Skeleton: nothing to clean up yet.
	}

	// ── Single-alarm scheduler (handoff §3.2, #32) ────────────────────────────

	/**
	 * The one alarm fired (handoff §3.2). Cloudflare gives a DO a single alarm, so
	 * on wake we drain *everything* due — not just the job that tripped it — then
	 * re-arm at the new minimum. Order: process due schedule jobs (rescheduling
	 * recurring ones, deleting one-shots), then run the timer sweeps so an over-max
	 * stopwatch or a passed countdown deadline resolves precisely on the alarm
	 * rather than waiting for the next read, then re-arm at MIN over all sources.
	 */
	override async alarm(): Promise<void> {
		if (this.status() !== "active" || this.isPaused()) {
			this.ctx.storage.deleteAlarm();
			return;
		}
		const now = Date.now();
		for (const item of dueItems(this.scheduleRows(), now)) {
			this.runScheduledJob(item, now);
			const payload = this.schedulePayload(item);
			const interval = payload.interval_ms ?? 0;
			if (interval > 0) {
				this.sql.exec(
					`UPDATE schedule SET next_fire_at = ? WHERE id = ?`,
					catchUpFireAt(item.next_fire_at, interval, now),
					item.id,
				);
			} else {
				this.sql.exec(`DELETE FROM schedule WHERE id = ?`, item.id);
			}
		}
		// Timer consequences are future-dated too; the alarm makes them precise.
		this.sweepOverMaxStopwatches(now);
		this.sweepExpiredCountdowns(now);
		this.armAlarm();
	}

	/**
	 * Runs one due schedule job (handoff §3.2). The rollover jobs evaluate streaks
	 * and clear scheduled counters; an unknown kind is an inert no-op so a stale or
	 * future job type never throws mid-drain.
	 */
	private runScheduledJob(item: ScheduleRow, now: number): void {
		switch (item.kind) {
			case "daily_rollover":
				this.runRollover("daily", now);
				return;
			case "weekly_rollover":
				this.runRollover("weekly", now);
				return;
		}
	}

	/**
	 * A day/week rollover (handoff §4.4, §3.2). Streaks first, *then* resets: each
	 * streak counter reads its target-counter's end-of-period value to fold
	 * `target met? +1 : 0`, so the reset that clears that target must come after.
	 * Every outcome is written to the trace as a `system_job` (no causing event),
	 * making the rollover legible in the same transparency log as rule effects.
	 */
	private runRollover(period: "daily" | "weekly", now: number): void {
		// One read of the counters covers everything: parse the definitions and keep a
		// value map from the same rows, rather than re-querying each value back out with
		// counterById. The streak loop reads its target's pre-reset value here, so the
		// map is refreshed as streaks fold, keeping it consistent for the reset loop.
		const rows = this.counterRows();
		const defs = rows.map(
			(row) => JSON.parse(row.definition) as CounterDefinition,
		);
		const valueById = new Map(rows.map((r) => [r.id, r.value]));
		for (const def of defs) {
			const streak = def.streak;
			if (!streak || streak.period !== period) continue;
			const targetDef = defs.find((d) => d.id === streak.counter);
			if (!targetDef) continue;
			const target =
				period === "daily" ? targetDef.daily_target : targetDef.weekly_target;
			const met = targetMet(valueById.get(streak.counter) ?? 0, target);
			const from = valueById.get(def.id) ?? 0;
			const to = nextStreak(from, met);
			// A dormant streak (target unmet, already 0) folds 0 -> 0. Skip the no-op so
			// we don't write an UPDATE and a trace row on every rollover forever, the way
			// the reset loop below guards its own no-ops.
			if (to === from) continue;
			this.sql.exec(
				`UPDATE counters SET value = ?, updated_at = ? WHERE id = ?`,
				to,
				now,
				def.id,
			);
			valueById.set(def.id, to);
			this.writeTrace(
				traceStreakRollover(now, def.id, {
					period,
					target_counter: streak.counter,
					met,
					from,
					to,
				}),
			);
		}
		for (const def of defs) {
			if (def.reset !== period) continue;
			const value = valueById.get(def.id) ?? 0;
			if (value === 0) continue;
			this.sql.exec(
				`UPDATE counters SET value = 0, updated_at = ? WHERE id = ?`,
				now,
				def.id,
			);
			this.writeTrace(
				traceScheduledReset(now, def.id, { period, from: value, to: 0 }),
			);
		}
	}

	/**
	 * Ensures the recurring rollover jobs exist (handoff §3.2). Idempotent — inserts
	 * each only if absent, so an already-running rollover keeps its `next_fire_at`
	 * rather than being dragged to a fresh boundary on every wake. A fixed interval
	 * suffices because a UTC boundary plus DAY_MS/WEEK_MS is still a boundary. Only
	 * for an active couple; a paused/pairing DO accrues no rollovers.
	 */
	private ensureRolloverScheduled(): void {
		if (this.status() !== "active") return;
		const now = Date.now();
		this.insertScheduleIfAbsent("daily_rollover", nextDailyRollover(now), {
			interval_ms: DAY_MS,
		});
		this.insertScheduleIfAbsent("weekly_rollover", nextWeeklyRollover(now), {
			interval_ms: WEEK_MS,
		});
	}

	private insertScheduleIfAbsent(
		id: string,
		nextFireAt: number,
		payload: SchedulePayload,
	): void {
		this.sql.exec(
			`INSERT INTO schedule (id, next_fire_at, kind, payload) VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO NOTHING`,
			id,
			nextFireAt,
			id,
			JSON.stringify(payload),
		);
	}

	/**
	 * Replays the alarm's scheduled resets across a time gap during a counter rebuild
	 * (see {@link rebuildCounters}). If a daily and/or weekly UTC boundary falls in
	 * `(from, to]`, the matching reset counters are zeroed — reproducing off-log
	 * `scheduled_reset`s the event log itself never recorded. Multiple boundaries of
	 * the same period in one gap collapse to a single zeroing: a gap spans no events,
	 * so nothing accrues between them.
	 */
	private replayScheduledResets(
		from: number,
		to: number,
		dailyResetIds: Set<string>,
		weeklyResetIds: Set<string>,
	): void {
		const dailyAt = nextDailyRollover(from);
		if (dailyAt <= to) this.zeroResetCounters(dailyResetIds, dailyAt);
		const weeklyAt = nextWeeklyRollover(from);
		if (weeklyAt <= to) this.zeroResetCounters(weeklyResetIds, weeklyAt);
	}

	/**
	 * Zeroes the given reset counters at `at`, skipping any already at 0 — mirroring
	 * the live rollover's no-op guard so an untouched counter keeps its prior
	 * `updated_at` rather than being stamped by a reset that changed nothing.
	 */
	private zeroResetCounters(ids: Set<string>, at: number): void {
		for (const id of ids) {
			this.sql.exec(
				`UPDATE counters SET value = 0, updated_at = ? WHERE id = ? AND value != 0`,
				at,
				id,
			);
		}
	}

	private counterDefinitions(): CounterDefinition[] {
		return this.counterRows().map(
			(row) => JSON.parse(row.definition) as CounterDefinition,
		);
	}

	/**
	 * Arms the single alarm at the earliest pending fire across every source
	 * (handoff §3.2 — `MIN(next_fire_at)`): scheduled jobs plus the nearest timer
	 * consequence (a stopwatch's per-activity max, a running countdown's deadline).
	 * With nothing pending the alarm is cleared, so a dormant couple costs nothing.
	 * Suspended while not active (pairing/dissolved) or paused (safeword, #40) — no
	 * consequences accrue.
	 */
	private armAlarm(): void {
		if (this.status() !== "active" || this.isPaused()) {
			this.ctx.storage.deleteAlarm();
			return;
		}
		const scheduleMin = earliestFireAt(
			this.scheduleRows().map((row) => row.next_fire_at),
		);
		const timerMin = this.nextTimerExpiryAt();
		const at = earliestFireAt([scheduleMin, timerMin]);
		if (at === null) this.ctx.storage.deleteAlarm();
		else this.ctx.storage.setAlarm(at);
	}

	/**
	 * The earliest future timer consequence to arm for, or null if none: over all
	 * open timers, a stopwatch's per-activity max and a running countdown's deadline
	 * (a paused countdown contributes none — its clock is frozen).
	 */
	private nextTimerExpiryAt(): number | null {
		const expiries: (number | null)[] = [];
		for (const row of this.openTimerRowsAll()) {
			if (row.kind === "stopwatch") {
				expiries.push(
					stopwatchExpiryAt(
						this.rowToOpenStopwatch(row),
						STOPWATCH_MAX_MS_BY_ACTIVITY,
						DEFAULT_STOPWATCH_MAX_MS,
					),
				);
			} else if (row.kind === "countdown") {
				expiries.push(countdownExpiryAt(this.rowToCountdown(row)));
			}
		}
		return earliestFireAt(expiries);
	}

	private openTimerRowsAll(): TimerRow[] {
		return this.sql
			.exec<TimerRow>(
				`SELECT id, kind, definition, state, status, opened_at, closed_at
					FROM timers WHERE status IS NULL`,
			)
			.toArray();
	}

	private scheduleRows(): ScheduleRow[] {
		return this.sql
			.exec<ScheduleRow>(
				`SELECT id, next_fire_at, kind, payload FROM schedule
					ORDER BY next_fire_at ASC, id ASC`,
			)
			.toArray();
	}

	private schedulePayload(row: ScheduleRow): SchedulePayload {
		return row.payload ? (JSON.parse(row.payload) as SchedulePayload) : {};
	}
}
