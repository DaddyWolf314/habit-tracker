import type {
	AgreementKind,
	CreateAgreementInput,
	ReviseAgreementInput,
	VersionedAgreement,
} from "#/shared/agreements.ts";
import type { AmendmentInput } from "#/shared/amendments.ts";
import type { AnchorView } from "#/shared/anchors.ts";
import type { ConversationFlagView } from "#/shared/conversations.ts";
import type {
	Counter,
	CreateCounterBody,
	UpdateCounterBody,
} from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView, LogEventInput } from "#/shared/events.ts";
import type {
	CoupleExport,
	CoupleStatus,
	CreateIdentityResult,
	Device,
	InviteResult,
	MintDeviceResult,
	RoleAssignment,
	RoleConfirmationState,
	Session,
} from "#/shared/identity.ts";
import type {
	AuditEntry,
	IntrospectionResult,
} from "#/shared/introspection.ts";
import type { OpenPromptView } from "#/shared/journaling.ts";
import type { RuleChangeNotice } from "#/shared/notifications.ts";
import type { RecoveryView } from "#/shared/recovery.ts";
import type { Role } from "#/shared/roles.ts";
import type { Rule, RuleDefinition, VersionedRule } from "#/shared/rules.ts";
import type { ScaffoldPlan } from "#/shared/scaffold.ts";
import type { TimerView } from "#/shared/timers.ts";
import type { CounterTrace, TraceRow } from "#/shared/trace.ts";
import { getBearer } from "./identity.ts";

/**
 * Thin client for the Worker JSON API. Attaches the bearer credential and
 * throws {@link ApiError} on non-2xx so callers (and TanStack Query) can react
 * to status codes.
 */
export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

interface ApiOptions {
	method?: string;
	body?: unknown;
	/** Bearer to use instead of the stored secret (e.g. a just-generated one). */
	bearer?: string | null;
}

export async function apiFetch<T>(
	path: string,
	options: ApiOptions = {},
): Promise<T> {
	const bearer = options.bearer !== undefined ? options.bearer : getBearer();
	const headers: Record<string, string> = {};
	if (options.body !== undefined) headers["content-type"] = "application/json";
	if (bearer) headers.Authorization = `Bearer ${bearer}`;

	const response = await fetch(path, {
		method: options.method ?? "GET",
		headers,
		body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
	});

	const text = await response.text();
	if (!response.ok) {
		// An error body isn't always ours — an edge 52x page or plain-text limit
		// error is not JSON, and must still surface as ApiError (callers key on
		// `status`), never as a bare SyntaxError from the parse.
		let message = "";
		try {
			const data = text ? (JSON.parse(text) as { error?: unknown }) : null;
			if (typeof data?.error === "string") message = data.error;
		} catch {}
		throw new ApiError(
			response.status,
			message || response.statusText || `HTTP ${response.status}`,
		);
	}
	return (text ? JSON.parse(text) : null) as T;
}

/** Creates the couple with a freshly generated secret (Partner A). */
export function createIdentity(bearer: string): Promise<CreateIdentityResult> {
	return apiFetch<CreateIdentityResult>("/api/identity", {
		method: "POST",
		bearer,
	});
}

export function getSession(bearer?: string): Promise<Session> {
	// An explicit bearer lets recovery validate a candidate secret *before*
	// persisting it as this device's identity (the handleLink pattern).
	return apiFetch<Session>(
		"/api/session",
		bearer === undefined ? {} : { bearer },
	);
}

/**
 * Adopts a minted device token as this device's bearer by confirming it against
 * the session whoami. A device token is already a valid bearer (the server just
 * hashes it), so linking a new device needs no dedicated endpoint — only this
 * validation before the caller persists the token. Throws {@link ApiError} 401
 * if the token is unknown or revoked.
 */
export function linkDevice(token: string): Promise<Session> {
	return apiFetch<Session>("/api/session", { bearer: token.trim() });
}

export function mintDevice(label?: string): Promise<MintDeviceResult> {
	return apiFetch<MintDeviceResult>("/api/devices", {
		method: "POST",
		body: { label },
	});
}

export function listDevices(): Promise<{ devices: Device[] }> {
	return apiFetch<{ devices: Device[] }>("/api/devices");
}

export function revokeDevice(deviceId: string): Promise<{ ok: true }> {
	return apiFetch<{ ok: true }>("/api/devices/revoke", {
		method: "POST",
		body: { device_id: deviceId },
	});
}

/** Partner A mints a pairing invite. */
export function createInvite(): Promise<InviteResult> {
	return apiFetch<InviteResult>("/api/invites", { method: "POST" });
}

/** Partner B redeems an invite with a freshly generated secret. */
export function redeemInvite(
	code: string,
	bearer: string,
): Promise<CreateIdentityResult> {
	return apiFetch<CreateIdentityResult>("/api/invites/redeem", {
		method: "POST",
		body: { code },
		bearer,
	});
}

export function getRoles(): Promise<RoleConfirmationState> {
	return apiFetch<RoleConfirmationState>("/api/roles");
}

export function proposeRoles(
	assignment: RoleAssignment,
): Promise<RoleConfirmationState> {
	return apiFetch<RoleConfirmationState>("/api/roles/propose", {
		method: "POST",
		body: { assignment },
	});
}

export function confirmRoles(): Promise<RoleConfirmationState> {
	return apiFetch<RoleConfirmationState>("/api/roles/confirm", {
		method: "POST",
	});
}

/** Export the caller's own view of the relationship. */
export function exportData(): Promise<CoupleExport> {
	return apiFetch<CoupleExport>("/api/export");
}

/** Unilaterally dissolve the pairing (freezes the dynamic). */
export function dissolve(): Promise<{ status: CoupleStatus }> {
	return apiFetch<{ status: CoupleStatus }>("/api/dissolve", {
		method: "POST",
	});
}

/**
 * Safeword: either partner, one tap, freezes all tracking and suspends every
 * consequence until {@link resume}. Idempotent (handoff §9, #40).
 */
export function pause(): Promise<{
	paused: boolean;
	paused_at: number | null;
}> {
	return apiFetch("/api/pause", { method: "POST" });
}

/** Lifts the safeword and restores prior state cleanly. Idempotent. */
export function resume(): Promise<{ paused: boolean }> {
	return apiFetch("/api/resume", { method: "POST" });
}

// ── Partner-assisted recovery (handoff §2, #41) ─────────────────────────────

/**
 * The remaining partner starts recovery of the lost member's slot; returns a
 * single-use code to hand the lost-token user, and when the slot may rebind.
 */
export function startRecovery(): Promise<{
	code: string;
	member_id: string;
	rebind_at: number;
	expires_at: number;
}> {
	return apiFetch("/api/recovery/start", { method: "POST" });
}

/** The lost-token user redeems the code with a brand-new secret (fresh identity). */
export function redeemRecovery(
	code: string,
	bearer: string,
): Promise<{ couple_do_id: string; member_id: string; rebind_at: number }> {
	return apiFetch("/api/recovery/redeem", {
		method: "POST",
		body: { code },
		bearer,
	});
}

/** Interrupt a pending recovery — the stolen-phone escape valve (either member). */
export function cancelRecovery(): Promise<{ ok: true }> {
	return apiFetch("/api/recovery/cancel", { method: "POST" });
}

/** After the waiting period, the fresh identity completes the slot rebind. */
export function finalizeRecovery(): Promise<{ ok: true }> {
	return apiFetch("/api/recovery/finalize", { method: "POST" });
}

/** The active recovery as this member sees it, or null. */
export function getRecovery(): Promise<{ recovery: RecoveryView | null }> {
	return apiFetch("/api/recovery");
}

/**
 * The content-free unread count for the notification badge (#42): a number only,
 * "You have N new items" — never any relationship content.
 */
export function getNotifications(): Promise<{ unread: number }> {
	return apiFetch("/api/notifications");
}

/**
 * Permanently delete the couple after it has been dissolved: the DO wipes its
 * storage and the routing rows are purged. Irreversible — offer an export first.
 */
export function deleteCouple(): Promise<{ ok: true }> {
	return apiFetch<{ ok: true }>("/api/couple", { method: "DELETE" });
}

/**
 * Ask why a projection changed (e.g. `counter:ritual_streak_days`). Every call
 * is audit-logged inside the couple's DO — support access leaves a visible mark.
 */
export function introspect(projection: string): Promise<IntrospectionResult> {
	return apiFetch<IntrospectionResult>("/api/support/introspect", {
		method: "POST",
		body: { projection },
	});
}

/** The append-only log of support-introspection accesses, newest first. */
export function listAuditLog(): Promise<{ entries: AuditEntry[] }> {
	return apiFetch<{ entries: AuditEntry[] }>("/api/support/audit");
}

// ── Phase 2: event log + counters ──────────────────────────────────────────

/** The couple's event-type schema set (starter seven + custom). */
export function listEventTypes(): Promise<{ types: EventType[] }> {
	return apiFetch<{ types: EventType[] }>("/api/event-types");
}

/** The event log, newest first, as composite views. */
/**
 * Marks rulings the caller has received as seen (#136, §8.3). Sent by the log,
 * which is where the ruling's content lives — the count only ever says *that*
 * something landed.
 */
/** How many events await the caller's ruling (#136) — Today's queue entry. */
export function queueCount(): Promise<{ awaiting: number }> {
	return apiFetch<{ awaiting: number }>("/api/queue/count");
}

/**
 * The check-ins asking to talk that nobody has answered yet (#88, ADR 0007).
 * Folded server-side, like the queue count beside it, so Today never holds the
 * log to find a metadata flag.
 */
export function listConversationFlags(): Promise<{
	flags: ConversationFlagView[];
}> {
	return apiFetch<{ flags: ConversationFlagView[] }>("/api/conversation-flags");
}

/** Marks a partner's rulings and responses on your own events seen (#136, #183). */
export function ackUpdates(): Promise<{ ok: boolean }> {
	return apiFetch<{ ok: boolean }>("/api/updates/seen", { method: "POST" });
}

export function listEvents(): Promise<{ events: EventView[] }> {
	return apiFetch<{ events: EventView[] }>("/api/events");
}

/** Appends an event to the log (also the sugar target for counter taps). */
export function logEvent(input: LogEventInput): Promise<EventView> {
	return apiFetch<EventView>("/api/events", { method: "POST", body: input });
}

/**
 * Records an amendment against an event (handoff §4.2): a ruling, a note, or a
 * retraction. Returns the event's refreshed composite view.
 */
export function amendEvent(input: AmendmentInput): Promise<EventView> {
	return apiFetch<EventView>("/api/events/amend", {
		method: "POST",
		body: input,
	});
}

/** The projections a single event touched (trace drill-in). */
export function getEventTrace(eventId: string): Promise<{ rows: TraceRow[] }> {
	return apiFetch<{ rows: TraceRow[] }>(
		`/api/events/trace?event_id=${encodeURIComponent(eventId)}`,
	);
}

/**
 * The couple's installed rule set. The dom's confirm sheet re-runs the pure
 * engine over these client-side to preview a ruling's effects before commit
 * (handoff §8) — the same `reevaluate` the DO applies, so the two agree.
 */
export function listRules(): Promise<{ rules: Rule[] }> {
	return apiFetch<{ rules: Rule[] }>("/api/rules");
}

/**
 * The full rule set with provenance and effective-dated version history (#64) for
 * the rules screen. A pure read — acknowledging rule-change notices is the
 * explicit {@link ackRuleChanges}.
 */
export function listRuleHistory(): Promise<{ rules: VersionedRule[] }> {
	return apiFetch<{ rules: VersionedRule[] }>("/api/rules/history");
}

/**
 * The rule changes the caller hasn't acknowledged yet (#64): the partner's
 * authoring actions plus any upstream default changes to adopted rules.
 * `RuleChangeNotice` on Today renders each via `ruleChangeNotice` and acks with
 * {@link ackRuleChanges} once shown (#123 — the notice is ADR 0002's consent
 * substitute, so it does not live with the editor in Settings).
 */
export function listRuleChanges(): Promise<{ changes: RuleChangeNotice[] }> {
	return apiFetch<{ changes: RuleChangeNotice[] }>("/api/rules/changes");
}

/** Marks the caller's rule-change notices seen, clearing them from the badge. */
export function ackRuleChanges(): Promise<{ ok: boolean }> {
	return apiFetch<{ ok: boolean }>("/api/rules/changes/seen", {
		method: "POST",
		body: {},
	});
}

/** Creates a custom rule (dom/switch only). Body is a flat rule with an id. */
export function createRule(rule: Rule): Promise<Rule> {
	return apiFetch<Rule>("/api/rules", { method: "POST", body: rule });
}

/** Edits a rule's condition/effects (dom/switch only); appends a new version. */
export function updateRule(
	id: string,
	definition: RuleDefinition,
): Promise<Rule> {
	return apiFetch<Rule>(`/api/rules/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: definition,
	});
}

/**
 * Renames a rule (dom/switch only) — an effective-dated edit like any other, so
 * the revision history keeps saying what it was called before (#150, ADR 0009).
 *
 * Name-only rather than a full `updateRule`, because the rules the picker refuses
 * to edit ("advanced — view only" timer wiring) still have to be renameable, and
 * round-tripping effects the screen cannot render is how they would get mangled.
 */
export function renameRule(id: string, name: string): Promise<VersionedRule> {
	return apiFetch<VersionedRule>(`/api/rules/${encodeURIComponent(id)}/name`, {
		method: "PUT",
		body: { name },
	});
}

/** Enables or disables a rule (dom/switch only) — an effective-dated toggle. */
export function setRuleEnabled(
	id: string,
	enabled: boolean,
): Promise<VersionedRule> {
	return apiFetch<VersionedRule>(
		`/api/rules/${encodeURIComponent(id)}/enabled`,
		{ method: "PUT", body: { enabled } },
	);
}

/**
 * Removes a rule (dom/switch only). A custom rule that never fired is purged; any
 * pack rule or one that has fired collapses to a disable (ADR 0002). `purged`
 * says which happened.
 */
export function deleteRule(id: string): Promise<{ purged: boolean }> {
	return apiFetch<{ purged: boolean }>(`/api/rules/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

/**
 * The Agreement corpus (#121, ADR 0006). Reads are open to both members — an
 * Agreement is always shared, because a term binds two people — while every write
 * is authorized server-side by the kind's author list, so a refusal here is a 403
 * and not something the client should try to pre-empt.
 */
export function listAgreements(): Promise<{
	agreements: VersionedAgreement[];
}> {
	return apiFetch<{ agreements: VersionedAgreement[] }>("/api/agreements");
}

/** The kinds and who authors each — the sub side alone writes limits. */
export function listAgreementKinds(): Promise<{ kinds: AgreementKind[] }> {
	return apiFetch<{ kinds: AgreementKind[] }>("/api/agreement-kinds");
}

/**
 * Marks the partner's corpus changes seen (#121). Explicit, like the rule-change
 * ack: reading the screen is what prompted it, but a GET must never mutate.
 */
export function ackAgreementChanges(): Promise<{ ok: boolean }> {
	return apiFetch<{ ok: boolean }>("/api/agreements/changes/seen", {
		method: "POST",
	});
}

export function createAgreement(
	input: CreateAgreementInput,
): Promise<VersionedAgreement> {
	return apiFetch<VersionedAgreement>("/api/agreements", {
		method: "POST",
		body: input,
	});
}

/** Appends a version; never overwrites, so past citations keep resolving. */
export function reviseAgreement(
	id: string,
	input: ReviseAgreementInput,
): Promise<VersionedAgreement> {
	return apiFetch<VersionedAgreement>(
		`/api/agreements/${encodeURIComponent(id)}`,
		{ method: "PUT", body: input },
	);
}

export function rekindAgreement(
	id: string,
	kind: string,
): Promise<VersionedAgreement> {
	return apiFetch<VersionedAgreement>(
		`/api/agreements/${encodeURIComponent(id)}/kind`,
		{ method: "PUT", body: { kind } },
	);
}

/**
 * Retires an Agreement — the real "remove". Effective-dated, so it leaves the
 * picker while staying readable for every citation already made against it.
 */
/**
 * Tracks a ritual Agreement (#121): creates its target counter, streak and rule
 * in one call. Returns what was made, which is the same plan the preview showed.
 */
export function trackAgreement(id: string): Promise<ScaffoldPlan> {
	return apiFetch<ScaffoldPlan>(
		`/api/agreements/${encodeURIComponent(id)}/track`,
		{ method: "POST" },
	);
}

export function retireAgreement(
	id: string,
	effectiveFrom?: number,
): Promise<VersionedAgreement> {
	return apiFetch<VersionedAgreement>(
		`/api/agreements/${encodeURIComponent(id)}/retire`,
		{ method: "POST", body: { effective_from: effectiveFrom } },
	);
}

/** Hard delete, accepted only for an Agreement nothing has ever cited. */
export function deleteAgreement(id: string): Promise<{ id: string }> {
	return apiFetch<{ id: string }>(`/api/agreements/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

export function updateAgreementKind(
	id: string,
	authorPermission: Role[],
): Promise<AgreementKind> {
	return apiFetch<AgreementKind>(
		`/api/agreement-kinds/${encodeURIComponent(id)}`,
		{ method: "PATCH", body: { author_permission: authorPermission } },
	);
}

export function listCounters(): Promise<{ counters: Counter[] }> {
	return apiFetch<{ counters: Counter[] }>("/api/counters");
}

/** The elapsed-since anchors as live views ("days since …", handoff §4.5). */
export function listAnchors(): Promise<{ anchors: AnchorView[] }> {
	return apiFetch<{ anchors: AnchorView[] }>("/api/anchors");
}

export function createCounter(input: CreateCounterBody): Promise<Counter> {
	return apiFetch<Counter>("/api/counters", { method: "POST", body: input });
}

/** Edits a counter's definition in place; the id is fixed, only the policy changes. */
export function updateCounter(
	id: string,
	input: UpdateCounterBody,
): Promise<Counter> {
	return apiFetch<Counter>(`/api/counters/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: input,
	});
}

/** Deletes a counter definition (hard delete). Refused while a streak tracks it. */
export function deleteCounter(id: string): Promise<{ id: string }> {
	return apiFetch<{ id: string }>(`/api/counters/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}

/** A "+N / −N" tap — sugar that appends a `counter_adjusted` event. */
export function adjustCounter(
	counterId: string,
	delta: number,
	note?: string,
): Promise<Counter> {
	return apiFetch<Counter>("/api/counters/adjust", {
		method: "POST",
		body: { counter_id: counterId, delta, note },
	});
}

export function resetCounter(
	counterId: string,
	note?: string,
): Promise<Counter> {
	return apiFetch<Counter>("/api/counters/reset", {
		method: "POST",
		body: { counter_id: counterId, note },
	});
}

/** The full causal chain behind a counter (consent record + debug view). */
export function getCounterTrace(counterId: string): Promise<CounterTrace> {
	return apiFetch<CounterTrace>(
		`/api/counters/trace?counter_id=${encodeURIComponent(counterId)}`,
	);
}

/** Active + closed timers as live views for the today screen (handoff §9). */
export function listTimers(): Promise<{ timers: TimerView[] }> {
	return apiFetch<{ timers: TimerView[] }>("/api/timers");
}

/** The caller's outstanding journal prompts, for the answer picker (#102). */
export function listOpenPrompts(): Promise<{ prompts: OpenPromptView[] }> {
	return apiFetch<{ prompts: OpenPromptView[] }>("/api/prompts/open");
}

// Dom live control over a running countdown (ADR 0004). There is deliberately no
// `assignTimer` — assigning is a `task_assigned` / `denial_started` event logged
// via {@link logEvent}; a rule opens the countdown.
function timerCommand(timerId: string, verb: string, body?: unknown) {
	return apiFetch<TimerView>(
		`/api/timers/${encodeURIComponent(timerId)}/${verb}`,
		{ method: "POST", body },
	);
}

export function pauseTimer(timerId: string): Promise<TimerView> {
	return timerCommand(timerId, "pause");
}

export function resumeTimer(timerId: string): Promise<TimerView> {
	return timerCommand(timerId, "resume");
}

export function cancelTimer(timerId: string): Promise<TimerView> {
	return timerCommand(timerId, "cancel");
}

export function extendTimer(timerId: string, byMs: number): Promise<TimerView> {
	return timerCommand(timerId, "extend", { by_ms: byMs });
}
