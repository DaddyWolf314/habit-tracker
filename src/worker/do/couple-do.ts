import { DurableObject } from "cloudflare:workers";
import { ulid } from "#/lib/ulid.ts";
import type {
	Counter,
	CounterDefinition,
	CreateCounterInput,
} from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import { eventTypeSchema } from "#/shared/event-types.ts";
import type { Event, EventView, LogEventInput } from "#/shared/events.ts";
import type {
	ConsentEntry,
	CoupleExport,
	CoupleStatus,
	Device,
	ExportRow,
	RoleAssignment,
	RoleConfirmationState,
	Session,
} from "#/shared/identity.ts";
import {
	applyCounterEvent,
	compositeMetadata,
	isPending,
} from "#/shared/projections.ts";
import type { MetadataValue, Role } from "#/shared/roles.ts";
import type { CounterTrace, TraceRow } from "#/shared/trace.ts";
import {
	COUNTER_ADJUSTED_TYPE,
	COUNTER_RESET_TYPE,
	DEFAULT_EVENT_TYPES,
	EVENT_TYPES_VERSION,
	isBuiltinType,
	isReservedTypeId,
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
 * replay), and a trace row for every projection change. The general rules
 * engine, timers, and amendments still land in Phases 3–5.
 */
export class CoupleDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

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

	/** A member's exportable snapshot of the relationship. */
	async exportData(identityHash: string): Promise<CoupleExport> {
		const me = this.requireMember(identityHash);
		return {
			exported_at: Date.now(),
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
			events: this.eventRows().map((row) => this.eventExportRow(row)),
			counters: this.counterRows().map((row) => this.counterExportRow(row)),
		};
	}

	/**
	 * Flattens an event for the export (ExportRow is a flat, RPC-serializable
	 * map, so nested metadata is carried as a JSON string). Reuses `rowToEvent`
	 * so the parsing lives in one place.
	 */
	private eventExportRow(row: EventRow): ExportRow {
		const event = this.rowToEvent(row);
		return {
			id: event.id,
			type: event.type,
			actor: event.actor,
			subject: event.subject ?? null,
			occurred_at: event.occurred_at,
			logged_at: event.logged_at,
			metadata: JSON.stringify(event.metadata),
			note: event.note ?? null,
		};
	}

	/** Flattens a counter for the export — full definition, nothing dropped. */
	private counterExportRow(row: CounterRow): ExportRow {
		const counter = this.rowToCounter(row);
		return {
			id: counter.id,
			name: counter.name,
			valence: counter.valence,
			daily_target: counter.daily_target ?? null,
			weekly_target: counter.weekly_target ?? null,
			reset: counter.reset,
			modify_permission: JSON.stringify(counter.modify_permission),
			value: counter.value,
			updated_at: counter.updated_at,
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
	 * reserved counter-manipulation types. Idempotent (`INSERT OR IGNORE`) so it is
	 * safe to re-run; the version is recorded so a later template revision can be
	 * reconciled.
	 */
	private seedDefaults(): void {
		for (const type of DEFAULT_EVENT_TYPES) {
			this.sql.exec(
				`INSERT OR IGNORE INTO event_types (id, definition) VALUES (?, ?)`,
				type.id,
				JSON.stringify(type),
			);
		}
		this.setSetting("event_types_version", String(EVENT_TYPES_VERSION));
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
		this.validateMetadata(type, input.metadata, role);

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
		};
		this.sql.exec(
			`INSERT INTO events (id, type, actor, subject, occurred_at, logged_at, metadata, note)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			event.id,
			event.type,
			event.actor,
			event.subject ?? null,
			event.occurred_at,
			event.logged_at,
			JSON.stringify(event.metadata),
			event.note ?? null,
		);

		// Phase 2 "engine": only direct manipulation moves projections. The
		// general rule pack (R1–R18) that reacts to real events lands in Phase 3.
		this.applyDirectManipulation(event);

		return {
			...event,
			amendments: [],
			composite_metadata: event.metadata,
			pending: isPending(type, event.metadata),
		};
	}

	/** The event log, newest first, as composite views (handoff §4.6, §9). */
	async listEvents(identityHash: string, limit = 200): Promise<EventView[]> {
		this.requireMember(identityHash);
		const types = new Map(this.eventTypes().map((t) => [t.id, t]));
		return this.eventRows(limit).map((row) => {
			const event = this.rowToEvent(row);
			const type = types.get(event.type);
			// Amendments arrive in Phase 5; composite == original until then.
			const composite = compositeMetadata(event, []);
			return {
				...event,
				amendments: [],
				composite_metadata: composite,
				pending: type ? isPending(type, composite) : false,
			};
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
		});
		return this.rowToCounter(this.requireCounterRow(counterId));
	}

	/**
	 * Rebuilds every counter's value by replaying the log from scratch and
	 * overwrites the cache. The materialized value is only ever a cache (handoff
	 * §4.4); this is the proof — after a rebuild the values are identical.
	 */
	async rebuildCounters(identityHash: string): Promise<Counter[]> {
		this.requireMember(identityHash);
		const rows = this.counterRows();
		const values = new Map<string, number>(rows.map((r) => [r.id, 0]));
		// Each counter's own last-event time, mirroring the incremental path;
		// a counter with no events keeps `updated_at` null.
		const lastAt = new Map<string, number>();
		// Replay in append order so the fold matches live application exactly.
		for (const row of this.eventRows(undefined, "ASC")) {
			if (row.type !== COUNTER_ADJUSTED_TYPE && row.type !== COUNTER_RESET_TYPE)
				continue;
			const metadata = JSON.parse(row.metadata) as Record<
				string,
				MetadataValue
			>;
			const counterId = metadata.counter;
			if (typeof counterId !== "string" || !values.has(counterId)) continue;
			values.set(
				counterId,
				applyCounterEvent(values.get(counterId) ?? 0, {
					type: row.type,
					logged_at: row.logged_at,
					id: row.id,
					metadata,
				}),
			);
			lastAt.set(counterId, row.logged_at);
		}
		for (const [id, value] of values) {
			this.sql.exec(
				`UPDATE counters SET value = ?, updated_at = ? WHERE id = ?`,
				value,
				lastAt.get(id) ?? null,
				id,
			);
		}
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
			.exec<TraceRow>(
				`SELECT id, at, caused_by_event, caused_by_rule, projection, detail
					FROM trace WHERE projection = ? ORDER BY at DESC, id DESC`,
				`counter:${counterId}`,
			)
			.toArray();
		return { counter_id: counterId, value: counter.value, rows };
	}

	/** The projections a single event touched (handoff §4.6, drill-in). */
	async getEventTrace(
		identityHash: string,
		eventId: string,
	): Promise<TraceRow[]> {
		this.requireMember(identityHash);
		return this.sql
			.exec<TraceRow>(
				`SELECT id, at, caused_by_event, caused_by_rule, projection, detail
					FROM trace WHERE caused_by_event = ? ORDER BY at ASC, id ASC`,
				eventId,
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
		this.sql.exec(
			`INSERT INTO trace (at, caused_by_event, caused_by_rule, projection, detail)
				VALUES (?, ?, NULL, ?, ?)`,
			event.logged_at,
			event.id,
			`counter:${counterId}`,
			JSON.stringify({
				verb:
					event.type === COUNTER_RESET_TYPE
						? "reset_counter"
						: "adjust_counter",
				delta:
					event.type === COUNTER_ADJUSTED_TYPE
						? event.metadata.delta
						: undefined,
				from,
				to,
			}),
		);
	}

	/**
	 * Validates event metadata against the type schema: no unknown keys, required
	 * keys present, each value the right kind and within bounds, and the actor's
	 * role permitted to set each key (handoff §5). `awaiting` keys may be left
	 * unset — that is what makes the event pending.
	 */
	private validateMetadata(
		type: EventType,
		metadata: Record<string, MetadataValue>,
		role: Role | null,
	): void {
		for (const key of Object.keys(metadata)) {
			if (!type.metadata[key]) {
				throw coupleError("BAD_REQUEST", `unknown metadata key: ${key}`);
			}
		}
		for (const [key, field] of Object.entries(type.metadata)) {
			const value = metadata[key];
			if (value === undefined) {
				if (field.required && !type.awaiting.includes(key)) {
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
				`SELECT id, type, actor, subject, occurred_at, logged_at, metadata, note
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
		};
	}

	private counterRows(): CounterRow[] {
		return this.sql
			.exec<CounterRow>(
				`SELECT id, definition, value, updated_at FROM counters ORDER BY id`,
			)
			.toArray();
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

	override async alarm(): Promise<void> {
		// Single-alarm scheduler (handoff §3.2): on fire, process everything due
		// in `schedule`, then re-arm at MIN(next_fire_at). Built in Phase 4.
	}
}
