import type { AmendmentInput } from "#/shared/amendments.ts";
import type { Counter, CreateCounterBody } from "#/shared/counters.ts";
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
import type { RecoveryView } from "#/shared/recovery.ts";
import type { Rule } from "#/shared/rules.ts";
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
	const data = text ? JSON.parse(text) : null;
	if (!response.ok) {
		throw new ApiError(response.status, data?.error ?? response.statusText);
	}
	return data as T;
}

/** Creates the couple with a freshly generated secret (Partner A). */
export function createIdentity(bearer: string): Promise<CreateIdentityResult> {
	return apiFetch<CreateIdentityResult>("/api/identity", {
		method: "POST",
		bearer,
	});
}

export function getSession(): Promise<Session> {
	return apiFetch<Session>("/api/session");
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
export function getInbox(): Promise<{ unread: number }> {
	return apiFetch("/api/inbox");
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

export function listCounters(): Promise<{ counters: Counter[] }> {
	return apiFetch<{ counters: Counter[] }>("/api/counters");
}

export function createCounter(input: CreateCounterBody): Promise<Counter> {
	return apiFetch<Counter>("/api/counters", { method: "POST", body: input });
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
