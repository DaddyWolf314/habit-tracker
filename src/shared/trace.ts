import { z } from "zod";
import type { EffectOp } from "./engine.ts";
import { type MetadataValue, metadataValueSchema } from "./roles.ts";

/**
 * The Trace ledger (handoff §4.6) — the single, deep module that owns "what
 * caused a projection change." Every projection change (and every near-miss)
 * records its **cause** and its **detail**; tapping any counter or event
 * reconstructs the full chain. The consent-record view and the debugging view
 * are the same data.
 *
 * Pure and dependency-free (isomorphic like `engine.ts`/`projections.ts`), so the
 * Durable Object writes through the same builders/codec the client reads back
 * through, and it is unit-testable in plain Node. The DO keeps exactly one
 * `writeTrace` sink; everything about the taxonomy lives here.
 *
 * At rest a trace row is columns + a JSON `detail` string; this module encodes on
 * write and decodes to a typed row on read, so the string never leaks past the
 * seam.
 */

// ── Detail: WHAT changed ─────────────────────────────────────────────────────

const counterOpSchema = z.enum(["increment", "decrement", "reset"]);
const periodSchema = z.enum(["daily", "weekly"]);
const matchSchema = z.record(z.string(), metadataValueSchema);

/**
 * The typed change a trace row records — one variant per `kind`. This replaces
 * the former untyped `detail: string` blob: builders produce these, `encodeDetail`
 * serializes them, and the read model carries them decoded.
 */
export const traceDetailSchema = z.discriminatedUnion("kind", [
	/** A counter moved — rule effect or direct `+1` sugar; the cause distinguishes. */
	z.object({
		kind: z.literal("counter"),
		op: counterOpSchema,
		by: z.number().optional(),
		from: z.number(),
		to: z.number(),
	}),
	/** An elapsed-since anchor was reset (`at` is the event's occurred_at). */
	z.object({
		kind: z.literal("anchor"),
		at: z.number(),
		from: z.number().nullable(),
		to: z.number(),
	}),
	z.object({
		kind: z.literal("timer_open"),
		timer_id: z.string(),
		match_on: matchSchema.optional(),
		tag: z.string().optional(),
	}),
	z.object({
		kind: z.literal("timer_close"),
		matched: z.boolean(),
		timer_id: z.string().optional(),
		status: z.string().optional(),
		duration_ms: z.number().optional(),
		route_duration_to: z.string().optional(),
		reconciled_auto_closed: z.boolean().optional(),
		match_on: matchSchema.optional(),
		note: z.string().optional(),
	}),
	/** A ruling's timer op skipped — the instance already ended (no retroactive surgery). */
	z.object({
		kind: z.literal("timer_skipped"),
		reason: z.string(),
		op: z.enum(["open", "close"]),
	}),
	z.object({ kind: z.literal("notify"), target: z.string() }),
	/** A rule matched on type but didn't fire; drives the "waiting on: …" hint. */
	z.object({
		kind: z.literal("near_miss"),
		reason: z.string(),
		awaiting: z.array(z.string()),
	}),
	z.object({
		kind: z.literal("auto_close"),
		reason: z.literal("over_max"),
		flagged_for_review: z.boolean(),
		timer_id: z.string(),
		duration_ms: z.number(),
	}),
	z.object({
		kind: z.literal("expire"),
		reason: z.literal("past_deadline"),
		timer_id: z.string(),
	}),
	z.object({
		kind: z.literal("streak_rollover"),
		period: periodSchema,
		target_counter: z.string(),
		met: z.boolean(),
		from: z.number(),
		to: z.number(),
	}),
	z.object({
		kind: z.literal("scheduled_reset"),
		period: periodSchema,
		from: z.number(),
		to: z.number(),
	}),
	z.object({
		kind: z.literal("timer_command"),
		command: z.enum(["assign", "pause", "resume", "extend"]),
		timer_id: z.string(),
		deadline_at: z.number().optional(),
		remaining_ms: z.number().optional(),
		by_ms: z.number().optional(),
		match: matchSchema.optional(),
		tag: z.string().optional(),
	}),
]);
export type TraceDetail = z.infer<typeof traceDetailSchema>;

/**
 * What `decodeDetail` returns: a valid detail, or `unknown` for a malformed/legacy
 * row. The transparency surface must never throw, so an unreadable row degrades to
 * a generic line rather than crashing the log view.
 */
export type DecodedDetail = TraceDetail | { kind: "unknown" };

// ── Cause: WHY the row exists ────────────────────────────────────────────────

/**
 * The typed cause of a trace row, reconstructed from the stored columns. Replaces
 * the former overload where `caused_by_rule` doubled as a `'system_job'` /
 * `'dom_command'` sentinel — it now holds only real rule ids.
 */
export type TraceCause =
	| { by: "rule"; event: string; rule: string }
	| { by: "direct"; event: string }
	| { by: "amendment"; event: string; rule: string; amendment: string }
	| { by: "system_job" }
	| { by: "dom_command"; actor: string };

export const ruleCause = (event: string, rule: string): TraceCause => ({
	by: "rule",
	event,
	rule,
});
export const directCause = (event: string): TraceCause => ({
	by: "direct",
	event,
});
export const amendmentCause = (
	event: string,
	rule: string,
	amendment: string,
): TraceCause => ({ by: "amendment", event, rule, amendment });
export const systemJobCause = (): TraceCause => ({ by: "system_job" });
export const domCommandCause = (actor: string): TraceCause => ({
	by: "dom_command",
	actor,
});

/** The persisted cause columns of a trace row. */
export interface TraceCauseColumns {
	caused_by_event: string | null;
	caused_by_rule: string | null;
	caused_by_amendment: string | null;
	actor: string | null;
}

/** A cause → its stored columns. The one place the mapping is defined. */
export function causeColumns(cause: TraceCause): TraceCauseColumns {
	switch (cause.by) {
		case "rule":
			return {
				caused_by_event: cause.event,
				caused_by_rule: cause.rule,
				caused_by_amendment: null,
				actor: null,
			};
		case "amendment":
			return {
				caused_by_event: cause.event,
				caused_by_rule: cause.rule,
				caused_by_amendment: cause.amendment,
				actor: null,
			};
		case "direct":
			return {
				caused_by_event: cause.event,
				caused_by_rule: null,
				caused_by_amendment: null,
				actor: null,
			};
		case "dom_command":
			return {
				caused_by_event: null,
				caused_by_rule: null,
				caused_by_amendment: null,
				actor: cause.actor,
			};
		case "system_job":
			return {
				caused_by_event: null,
				caused_by_rule: null,
				caused_by_amendment: null,
				actor: null,
			};
	}
}

/** Stored columns → typed cause. Inverse of {@link causeColumns}. */
export function causeFromColumns(c: TraceCauseColumns): TraceCause {
	if (c.caused_by_amendment !== null && c.caused_by_event !== null) {
		return {
			by: "amendment",
			event: c.caused_by_event,
			rule: c.caused_by_rule ?? "",
			amendment: c.caused_by_amendment,
		};
	}
	if (c.caused_by_event !== null && c.caused_by_rule !== null) {
		return { by: "rule", event: c.caused_by_event, rule: c.caused_by_rule };
	}
	if (c.caused_by_event !== null)
		return { by: "direct", event: c.caused_by_event };
	if (c.actor !== null) return { by: "dom_command", actor: c.actor };
	return { by: "system_job" };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** A trace row to write: cause + when + which projection + the typed change. */
export interface TraceEntry {
	cause: TraceCause;
	at: number;
	/** The projection touched, e.g. `counter:demerits`; null for a near-miss. */
	projection: string | null;
	detail: TraceDetail;
}

/** A trace row as read back: the entry, decoded, plus its autoincrement id. */
export interface TraceRow {
	id: number;
	at: number;
	cause: TraceCause;
	projection: string | null;
	detail: DecodedDetail;
}

/** The raw stored columns of a trace row (before decode). */
export interface TraceRowColumns extends TraceCauseColumns {
	id: number;
	at: number;
	projection: string | null;
	detail: string | null;
}

/** The causal chain behind one counter: its trace rows, newest first. */
export interface CounterTrace {
	counter_id: string;
	value: number;
	rows: TraceRow[];
}

// ── Codec ────────────────────────────────────────────────────────────────────

export function encodeDetail(detail: TraceDetail): string {
	return JSON.stringify(detail);
}

/** Parses a stored detail string, degrading to `unknown` on anything unreadable. */
export function decodeDetail(raw: string | null): DecodedDetail {
	if (!raw) return { kind: "unknown" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "unknown" };
	}
	const result = traceDetailSchema.safeParse(parsed);
	return result.success ? result.data : { kind: "unknown" };
}

/** Stored columns → a typed read row. The seam the RPC boundary decodes through. */
export function decodeTraceRow(cols: TraceRowColumns): TraceRow {
	return {
		id: cols.id,
		at: cols.at,
		cause: causeFromColumns(cols),
		projection: cols.projection,
		detail: decodeDetail(cols.detail),
	};
}

// ── Builders (pure; the write side calls these, one sink writes them) ─────────

export function traceCounter(
	cause: TraceCause,
	at: number,
	counterId: string,
	change: {
		op: "increment" | "decrement" | "reset";
		by?: number;
		from: number;
		to: number;
	},
): TraceEntry {
	return {
		cause,
		at,
		projection: `counter:${counterId}`,
		detail: { kind: "counter", ...change },
	};
}

export function traceAnchor(
	cause: TraceCause,
	at: number,
	anchorId: string,
	change: { at: number; from: number | null; to: number },
): TraceEntry {
	return {
		cause,
		at,
		projection: `anchor:${anchorId}`,
		detail: { kind: "anchor", ...change },
	};
}

export function traceTimerOpen(
	cause: TraceCause,
	at: number,
	timer: string,
	info: {
		timer_id: string;
		match_on?: Record<string, MetadataValue>;
		tag?: string;
	},
): TraceEntry {
	return {
		cause,
		at,
		projection: `timer:${timer}`,
		detail: { kind: "timer_open", ...info },
	};
}

export function traceTimerClose(
	cause: TraceCause,
	at: number,
	timer: string,
	info: {
		matched: boolean;
		timer_id?: string;
		status?: string;
		duration_ms?: number;
		route_duration_to?: string;
		reconciled_auto_closed?: boolean;
		match_on?: Record<string, MetadataValue>;
		note?: string;
	},
): TraceEntry {
	return {
		cause,
		at,
		projection: `timer:${timer}`,
		detail: { kind: "timer_close", ...info },
	};
}

export function traceTimerSkipped(
	cause: TraceCause,
	at: number,
	timer: string,
	info: { reason: string; op: "open" | "close" },
): TraceEntry {
	return {
		cause,
		at,
		projection: `timer:${timer}`,
		detail: { kind: "timer_skipped", ...info },
	};
}

export function traceNotify(
	cause: TraceCause,
	at: number,
	target: string,
): TraceEntry {
	return {
		cause,
		at,
		projection: `notify:${target}`,
		detail: { kind: "notify", target },
	};
}

export function traceNearMiss(
	cause: TraceCause,
	at: number,
	info: { reason: string; awaiting: string[] },
): TraceEntry {
	return {
		cause,
		at,
		projection: null,
		detail: { kind: "near_miss", ...info },
	};
}

export function traceAutoClose(
	at: number,
	timer: string,
	info: { flagged_for_review: boolean; timer_id: string; duration_ms: number },
): TraceEntry {
	return {
		cause: systemJobCause(),
		at,
		projection: `timer:${timer}`,
		detail: { kind: "auto_close", reason: "over_max", ...info },
	};
}

export function traceExpire(
	at: number,
	timer: string,
	info: { timer_id: string },
): TraceEntry {
	return {
		cause: systemJobCause(),
		at,
		projection: `timer:${timer}`,
		detail: { kind: "expire", reason: "past_deadline", ...info },
	};
}

export function traceStreakRollover(
	at: number,
	counterId: string,
	info: {
		period: "daily" | "weekly";
		target_counter: string;
		met: boolean;
		from: number;
		to: number;
	},
): TraceEntry {
	return {
		cause: systemJobCause(),
		at,
		projection: `counter:${counterId}`,
		detail: { kind: "streak_rollover", ...info },
	};
}

export function traceScheduledReset(
	at: number,
	counterId: string,
	info: { period: "daily" | "weekly"; from: number; to: number },
): TraceEntry {
	return {
		cause: systemJobCause(),
		at,
		projection: `counter:${counterId}`,
		detail: { kind: "scheduled_reset", ...info },
	};
}

export function traceTimerCommand(
	actorId: string,
	at: number,
	timer: string,
	info: {
		command: "assign" | "pause" | "resume" | "extend";
		timer_id: string;
		deadline_at?: number;
		remaining_ms?: number;
		by_ms?: number;
		match?: Record<string, MetadataValue>;
		tag?: string;
	},
): TraceEntry {
	return {
		cause: domCommandCause(actorId),
		at,
		projection: `timer:${timer}`,
		detail: { kind: "timer_command", ...info },
	};
}

// ── Phrasing + decoders (the read side the UI renders through) ────────────────

/** Underscore-and-lowercase id → readable words: `rituals_completed` → "rituals completed". */
export function humanize(id: string): string {
	return id.replace(/_/g, " ").trim();
}

/**
 * The one phrase for a counter effect, shared by the chain view (what fired) and
 * the confirm sheet (what will fire) so the two never diverge. `by` defaults to 1.
 */
export function phraseCounter(
	name: string,
	op: "increment" | "decrement" | "reset",
	by?: number,
): string {
	const human = humanize(name);
	if (op === "reset") return `reset ${human}`;
	return `${op === "increment" ? "+" : "−"}${by ?? 1} ${human}`;
}

/**
 * A forward-running phrase for one effect a ruling would fire — the line the dom's
 * confirm sheet lists before commit (handoff §8). Visibility only; the actual
 * effects apply server-side.
 */
export function summarizeEffectOp(op: EffectOp): string {
	switch (op.kind) {
		case "counter":
			return phraseCounter(op.counter, op.op, op.by);
		case "anchor":
			return `reset ${humanize(op.anchor)} streak`;
		case "timer":
			return op.op === "open"
				? `start ${humanize(op.timer)}`
				: `mark ${humanize(op.timer)} ${op.status ?? "closed"}`;
		case "notify":
			return `notify ${humanize(op.target)}`;
	}
}

/** The tone of a chain line, so the UI styles rulings/near-misses/system jobs. */
export type TraceTone = "effect" | "near_miss" | "system" | "command";

/** One trace row rendered for the chain view — label-free, the UI styles `tone`. */
export interface TraceLine {
	tone: TraceTone;
	summary: string;
	note?: string;
}

/** The name after the `counter:` / `timer:` / `anchor:` prefix. */
function projectionName(projection: string | null): string {
	if (!projection) return "projection";
	const i = projection.indexOf(":");
	return i === -1 ? projection : projection.slice(i + 1);
}

/**
 * Describes one trace row as a structured, label-free line (mirrors
 * `describeAmendment` in `adjudication.ts`). Never throws — an unrecognized detail
 * degrades to a generic line, since this renders the consent-record + log view.
 */
export function describeTraceRow(row: TraceRow): TraceLine {
	const { cause, detail, projection } = row;
	const prefix =
		cause.by === "rule" || cause.by === "amendment" ? `${cause.rule} · ` : "";
	const name = projectionName(projection);
	switch (detail.kind) {
		case "near_miss":
			return { tone: "near_miss", summary: detail.reason };
		case "counter":
			return {
				tone: "effect",
				summary: `${prefix}${phraseCounter(name, detail.op, detail.by)}`,
			};
		case "anchor":
			return { tone: "effect", summary: `${prefix}reset ${humanize(name)}` };
		case "timer_open":
			return { tone: "effect", summary: `${prefix}started ${humanize(name)}` };
		case "timer_close":
			if (!detail.matched) {
				return {
					tone: "effect",
					summary: `${prefix}${humanize(name)}: no matching timer`,
					note: detail.note,
				};
			}
			if (detail.reconciled_auto_closed) {
				return {
					tone: "effect",
					summary: `${prefix}${humanize(name)}: recorded actual end`,
					note: detail.note,
				};
			}
			return {
				tone: "effect",
				summary: `${prefix}${humanize(name)} ${detail.status ?? "closed"}`,
			};
		case "timer_skipped":
			return { tone: "effect", summary: detail.reason };
		case "notify":
			return { tone: "effect", summary: `${prefix}notify ${humanize(name)}` };
		case "auto_close":
			return {
				tone: "system",
				summary: `${humanize(name)} auto-closed (over max)`,
			};
		case "expire":
			return { tone: "system", summary: `${humanize(name)} expired` };
		case "streak_rollover":
			return {
				tone: "system",
				summary: `${humanize(name)} streak ${detail.from} → ${detail.to}`,
			};
		case "scheduled_reset":
			return {
				tone: "system",
				summary: `${humanize(name)} reset (${detail.period})`,
			};
		case "timer_command":
			return {
				tone: "command",
				summary: `${detail.command} ${humanize(name)}`,
			};
		default:
			return { tone: "system", summary: "(unrecognized change)" };
	}
}
