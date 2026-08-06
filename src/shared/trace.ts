import { z } from "zod";
import { describeCitation, type VersionedAgreement } from "./agreements.ts";
import type { EffectOp } from "./engine.ts";
import { describeRewardCitation, type VersionedRewardItem } from "./rewards.ts";
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
 * A resolved rule effect, at rest inside a trace row (ADR 0016). Mirrors
 * {@link EffectOp}, which is a plain TypeScript type in the zod-free engine; the
 * two are kept honest by real code rather than an assertion — {@link traceWaived}
 * assigns an `EffectOp` *into* this shape, and {@link describeTraceRow} passes
 * this shape *into* `summarizeEffectOp`, so a divergence in either direction is a
 * compile error at a call site.
 *
 * Only the waiver rows carry one, and they carry it for a specific reason: what
 * was suppressed never became a projection change, so there is no `from`/`to` to
 * describe it by, and a rebuild must be able to render the row without asking a
 * rule definition that may have been edited since (ADR 0002).
 */
const effectOpSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("counter"),
		counter: z.string(),
		op: counterOpSchema,
		by: z.number().optional(),
	}),
	z.object({ kind: z.literal("anchor"), anchor: z.string(), at: z.number() }),
	z.object({
		kind: z.literal("timer"),
		timer: z.string(),
		op: z.enum(["open", "close"]),
		match_on: matchSchema.optional(),
		tag: z.string().optional(),
		duration_ms: z.number().optional(),
		status: z.enum(["completed", "failed"]).optional(),
		route_duration_to: z.string().optional(),
		route_when_met: z.boolean().optional(),
	}),
	z.object({ kind: z.literal("notify"), target: z.string() }),
	/** An effect that resolved to nothing — a `by_from` that routed no whole number. */
	z.object({
		kind: z.literal("skipped"),
		counter: z.string(),
		op: z.enum(["increment", "decrement"]),
		key: z.string(),
	}),
]);

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
	/**
	 * A counter effect that routed no magnitude (ADR 0015) — its `by_from` key was
	 * absent from the event, or carried something that is not a whole number.
	 *
	 * Its own kind rather than a `counter` row with a zero delta, and not a
	 * near-miss either: the rule *did* fire, and this says one of its effects had
	 * nothing to move. A zero-delta counter row would claim the counter was
	 * written; a near-miss would claim the rule never applied. Both are false, and
	 * the second is the one CONTEXT's **Effect** entry warns about.
	 */
	z.object({
		kind: z.literal("counter_skipped"),
		reason: z.string(),
		op: z.enum(["increment", "decrement"]),
		/** The `by_from` key that routed nothing usable — the actionable half. */
		key: z.string(),
	}),
	/**
	 * A counter crossed a rung going up (ADR 0015) — **a recorded moment, not a
	 * debt.** Nothing closes it and nobody owes anything: ADR 0007 pulls the other
	 * way, but the closer precedents are #182's empty `awaiting` for an act and the
	 * Response's "a gift, not a debt". An open crossing would assert an obligation
	 * the app cannot verify was discharged.
	 *
	 * The row is written beside the counter move rather than derived from it,
	 * because what it announces — the rung, and the term it cites — is resolved
	 * from the definition in force at the move, and a later edit to the ladder must
	 * not rewrite what a past crossing said.
	 */
	z.object({
		kind: z.literal("crossing"),
		/** The rung's threshold. Not the row's `at`, which is when the move landed. */
		rung: z.number().int(),
		/** The Agreement the rung cites — its wording, never a copy of the prose. */
		agreement_ref: z.string(),
		/**
		 * The moment the cited term resolves against: the causing event's
		 * `occurred_at` (ADR 0006), or the boundary for a rollover fold, which has no
		 * causing event. Stored for the reason the `anchor` detail stores one — the
		 * row's own `at` is log-time, and a consented term is read at the moment the
		 * person was bound — and stored rather than left to the reader because the
		 * counter's own chain view renders these rows without the events beside them.
		 */
		occurred_at: z.number().int(),
		from: z.number(),
		to: z.number(),
	}),
	/**
	 * A currency crossed a **Price** going up (ADR 0017) — affordability, said in
	 * the one vocabulary the app already has for passing a line.
	 *
	 * Its own `kind` beside `crossing` rather than a variant of it, because what it
	 * cites differs: a rung names an **Agreement**, this names a **Reward item**,
	 * and they resolve through different definitions. Everything else about it is
	 * deliberately identical — upward only, one row per line passed, no effects, no
	 * debt — because ADR 0017 asks affordability to *be* a crossing rather than a
	 * second pressure surface, and a shape that drifted would make that untrue.
	 *
	 * The price is stored rather than re-read, exactly as the rung is: a later
	 * reprice must not rewrite what a past announcement said the item cost.
	 */
	z.object({
		kind: z.literal("price_crossing"),
		/** What the item cost when the currency passed it. */
		price: z.number().int(),
		/** The item now affordable — its *name*, never a copy, resolves from this. */
		reward_ref: z.string(),
		/** The moment the cited item resolves against (the causing event's). */
		occurred_at: z.number().int(),
		from: z.number(),
		to: z.number(),
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
	/**
	 * An effect the dom overruled (ADR 0016). One row records **both halves** of
	 * the fact — that R12 proposed +2 demerits, and that the dom waived it — which
	 * is why the proposed `op` rides along rather than the row being a bare note
	 * beside a counter row.
	 *
	 * `suppressed` is the confirm-sheet mechanic: the effect was never applied, so
	 * there is no `from`/`to`, and the counter's history carries no peak that never
	 * existed. `reversed` is the after-the-fact mechanic: `from`/`to` are the
	 * compensating move, and `op` stays the effect that was *overruled* rather than
	 * the inverse, because that is what a reader is being told about.
	 *
	 * Not a near-miss, deliberately: a near-miss is a rule that did not match, and
	 * the ledger has to be able to distinguish "this never applied to you" from
	 * "this applied and I let it go".
	 */
	z.object({
		kind: z.literal("waived"),
		mechanic: z.enum(["suppressed", "reversed"]),
		op: effectOpSchema,
		from: z.number().optional(),
		to: z.number().optional(),
	}),
	/**
	 * An effect that could not be un-fired, and why (ADR 0016) — in the shape a
	 * near-miss established: the engine records why a rule did not fire so pending
	 * state is legible, and the same instinct says to record why an effect did not
	 * un-fire. This is #184's asymmetry stated in the ledger rather than lurking in
	 * the model, and it is why a correction can always land.
	 */
	z.object({
		kind: z.literal("reversal_declined"),
		reason: z.string(),
		op: effectOpSchema,
	}),
	z.object({
		kind: z.literal("timer_command"),
		// Live dom control over a running countdown (ADR 0004). Opening is no longer
		// a command — it is a rule firing on a `task_assigned`/`denial_started` event —
		// so there is no `assign`; `cancel` calls a live countdown off early.
		command: z.enum(["pause", "resume", "extend", "cancel"]),
		timer_id: z.string(),
		deadline_at: z.number().optional(),
		remaining_ms: z.number().optional(),
		by_ms: z.number().optional(),
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
	| { by: "rule"; event: string; rule: string; effect_index?: number }
	| { by: "direct"; event: string }
	| {
			by: "amendment";
			event: string;
			rule: string;
			amendment: string;
			effect_index?: number;
	  }
	| { by: "system_job" }
	| { by: "dom_command"; actor: string };

export const ruleCause = (
	event: string,
	rule: string,
	effectIndex?: number,
): TraceCause => ({ by: "rule", event, rule, effect_index: effectIndex });
export const directCause = (event: string): TraceCause => ({
	by: "direct",
	event,
});
export const amendmentCause = (
	event: string,
	rule: string,
	amendment: string,
	effectIndex?: number,
): TraceCause => ({
	by: "amendment",
	event,
	rule,
	amendment,
	effect_index: effectIndex,
});
export const systemJobCause = (): TraceCause => ({ by: "system_job" });
export const domCommandCause = (actor: string): TraceCause => ({
	by: "dom_command",
	actor,
});

/**
 * The persisted cause columns of a trace row.
 *
 * `effect_index` is part of the *cause*, not the detail: it completes the answer
 * to "why does this row exist" — not merely rule R12, but R12's second effect —
 * and that pair is the identity a waiver names (ADR 0016). Keeping it here rather
 * than duplicating an optional field across every effect-shaped detail is what
 * lets a standalone waiver find the row a landed effect wrote without the trace
 * row ids having to be stable, which a rebuild makes sure they are not.
 */
export interface TraceCauseColumns {
	caused_by_event: string | null;
	caused_by_rule: string | null;
	caused_by_amendment: string | null;
	actor: string | null;
	effect_index: number | null;
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
				effect_index: cause.effect_index ?? null,
			};
		case "amendment":
			return {
				caused_by_event: cause.event,
				caused_by_rule: cause.rule,
				caused_by_amendment: cause.amendment,
				actor: null,
				effect_index: cause.effect_index ?? null,
			};
		case "direct":
			return {
				caused_by_event: cause.event,
				caused_by_rule: null,
				caused_by_amendment: null,
				actor: null,
				effect_index: null,
			};
		case "dom_command":
			return {
				caused_by_event: null,
				caused_by_rule: null,
				caused_by_amendment: null,
				actor: cause.actor,
				effect_index: null,
			};
		case "system_job":
			return {
				caused_by_event: null,
				caused_by_rule: null,
				caused_by_amendment: null,
				actor: null,
				effect_index: null,
			};
	}
}

/** Stored columns → typed cause. Inverse of {@link causeColumns}. */
export function causeFromColumns(c: TraceCauseColumns): TraceCause {
	// Rows written before the column existed carry null, which reads back as "this
	// effect cannot be named by a waiver" — the honest answer, since nothing
	// recorded which effect of the rule it was.
	const effectIndex = c.effect_index ?? undefined;
	if (c.caused_by_amendment !== null && c.caused_by_event !== null) {
		return {
			by: "amendment",
			event: c.caused_by_event,
			rule: c.caused_by_rule ?? "",
			amendment: c.caused_by_amendment,
			effect_index: effectIndex,
		};
	}
	if (c.caused_by_event !== null && c.caused_by_rule !== null) {
		return {
			by: "rule",
			event: c.caused_by_event,
			rule: c.caused_by_rule,
			effect_index: effectIndex,
		};
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

/**
 * A counter effect that routed no magnitude (ADR 0015). Lands on the counter's
 * own chain, exactly as a suppressed effect does, because "why is this not 12" is
 * asked of the counter — a note filed anywhere else would be unfindable from the
 * number that failed to move.
 */
export function traceCounterSkipped(
	cause: TraceCause,
	at: number,
	counterId: string,
	info: { reason: string; op: "increment" | "decrement"; key: string },
): TraceEntry {
	return {
		cause,
		at,
		projection: `counter:${counterId}`,
		detail: { kind: "counter_skipped", ...info },
	};
}

/**
 * A counter crossed a rung (ADR 0015). Lands on the counter's own chain beside
 * the move that crossed it, and takes that move's cause — a rule effect, a direct
 * `+1`, or the rollover fold — because the crossing has no cause of its own: it is
 * the same fact about the same move, said in the couple's terms.
 */
export function traceCrossing(
	cause: TraceCause,
	at: number,
	counterId: string,
	info: {
		rung: number;
		agreement_ref: string;
		occurred_at: number;
		from: number;
		to: number;
	},
): TraceEntry {
	return {
		cause,
		at,
		projection: `counter:${counterId}`,
		detail: { kind: "crossing", ...info },
	};
}

/**
 * A currency crossed a price (ADR 0017). Lands on the counter's own chain beside
 * the move that crossed it and takes that move's cause, for the reason
 * {@link traceCrossing} gives: it is the same fact about the same move, said in
 * the store's terms rather than the ladder's.
 */
export function tracePriceCrossing(
	cause: TraceCause,
	at: number,
	counterId: string,
	info: {
		price: number;
		reward_ref: string;
		occurred_at: number;
		from: number;
		to: number;
	},
): TraceEntry {
	return {
		cause,
		at,
		projection: `counter:${counterId}`,
		detail: { kind: "price_crossing", ...info },
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

/**
 * An effect the dom overruled (ADR 0016). `op` is the effect that was
 * *overruled*, in both mechanics — for a reversal the compensating move is
 * carried as `from`/`to` instead, since "R12's +2 demerits, reversed" is what a
 * reader is being told and "−2 demerits" is merely how it was done.
 */
export function traceWaived(
	cause: TraceCause,
	at: number,
	info: {
		mechanic: "suppressed" | "reversed";
		op: EffectOp;
		from?: number;
		to?: number;
	},
): TraceEntry {
	return {
		cause,
		at,
		projection: projectionOf(info.op),
		detail: { kind: "waived", ...info },
	};
}

/** An effect whose inverse no longer commutes, with the reason (ADR 0016). */
export function traceReversalDeclined(
	cause: TraceCause,
	at: number,
	info: { reason: string; op: EffectOp },
): TraceEntry {
	return {
		cause,
		at,
		projection: projectionOf(info.op),
		detail: { kind: "reversal_declined", ...info },
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
		command: "pause" | "resume" | "extend" | "cancel";
		timer_id: string;
		deadline_at?: number;
		remaining_ms?: number;
		by_ms?: number;
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
 * The projection an effect op targets, in the `kind:id` form the trace column
 * uses. The one place the mapping is written down, so a waiver row lands on the
 * same projection its effect would have — a suppressed `+2 demerits` has to
 * appear on `counter:demerits`'s chain even though the counter never moved,
 * because "why is this not 12" is asked of the counter.
 */
export function projectionOf(op: EffectOp): string {
	switch (op.kind) {
		case "counter":
			return `counter:${op.counter}`;
		case "anchor":
			return `anchor:${op.anchor}`;
		case "timer":
			return `timer:${op.timer}`;
		case "notify":
			return `notify:${op.target}`;
		case "skipped":
			// The counter it would have moved, so the note sits on the chain of the
			// number a reader is asking about (ADR 0015).
			return `counter:${op.counter}`;
	}
}

/**
 * A forward-running phrase for one effect a ruling would fire — the line the dom's
 * confirm sheet lists before commit (handoff §8), and the line a `waived` row
 * reads back through. The sheet's list is no longer visibility-only: each line is
 * a checkbox, and unchecking one waives that effect (ADR 0016). Sharing this
 * function is what makes the ledger say it in the words the dom unchecked. The
 * effects themselves still apply — or are withheld — server-side.
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
		case "skipped":
			// Says what did *not* happen and why, in the same breath. The confirm
			// sheet drops these lines rather than offering a checkbox — waiving an
			// effect that resolves to nothing is a control with nothing behind it —
			// so in practice this is read on the chain, beside the counter that
			// stayed put.
			return `${humanize(op.counter)} unchanged — no whole number at ${humanize(op.key)}`;
	}
}

/**
 * The tone of a chain line, so the UI styles rulings/near-misses/system jobs.
 *
 * `declined` is deliberately **not** `near_miss`, though both record a
 * non-action with a stated reason and both read as muted. CONTEXT's **Effect**
 * entry forbids the conflation outright — "_Avoid_: reading a waived effect as a
 * near-miss; the rule fired and was overruled" — and a `reversal_declined` row is
 * the sharpest case of it: the effect fired *and is still standing*, so the
 * near-miss glyph would tell the reader the exact opposite of what happened.
 * Sharing the tone value is how that reading gets into the UI by accident.
 */
export type TraceTone =
	| "effect"
	| "near_miss"
	| "declined"
	| "system"
	| "command";

/** One trace row rendered for the chain view — label-free, the UI styles `tone`. */
export interface TraceLine {
	tone: TraceTone;
	summary: string;
	note?: string;
}

/** The name after the `counter:` / `timer:` / `anchor:` prefix. */
export function projectionName(projection: string | null): string {
	if (!projection) return "projection";
	const i = projection.indexOf(":");
	return i === -1 ? projection : projection.slice(i + 1);
}

/**
 * What a line needs from outside the row itself. Only a crossing wants anything:
 * it cites an Agreement, and a citation renders as the term's *name*, never as
 * its id (ADR 0006).
 *
 * Optional, and every caller that has no corpus to hand gets a line naming the
 * raw ref instead — an opaque id is a better answer than a blank, which is the
 * same call `describeCitation` makes for a term the couple no longer holds.
 */
export interface TraceContext {
	agreements?: VersionedAgreement[];
	/** The store a **price crossing** names its item through (ADR 0017). */
	rewards?: VersionedRewardItem[];
	/**
	 * "Now", for the `(now: …)` half a renamed term renders. Defaults to the
	 * crossing's own moment, which reads as "nothing has been renamed since".
	 */
	now?: number;
}

/**
 * Describes one trace row as a structured, label-free line (mirrors
 * `describeAmendment` in `adjudication.ts`). Never throws — an unrecognized detail
 * degrades to a generic line, since this renders the consent-record + log view.
 */
export function describeTraceRow(
	row: TraceRow,
	context: TraceContext = {},
): TraceLine {
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
		case "counter_skipped":
			// `effect` rather than `near_miss`: the rule fired and this effect had
			// nothing to move, which is a different fact from the rule not applying.
			return { tone: "effect", summary: detail.reason };
		case "crossing": {
			// The term as it read **when the act happened** (ADR 0006), resolved
			// through the same `describeCitation` an event's citing ref renders
			// through, so a crossing and the event that caused it name the term the
			// same way. Renegotiating the consequence afterwards writes a new version
			// with a later `effective_from`, which this reading never reaches — so a
			// past crossing keeps announcing what it announced.
			const cited =
				describeCitation(
					context.agreements ?? [],
					detail.agreement_ref,
					detail.occurred_at,
					context.now ?? detail.occurred_at,
				) ?? detail.agreement_ref;
			return {
				// `effect`, not `system`: a crossing is something that happened to a
				// projection, not a non-action and not a job's housekeeping — and it
				// keeps the tone of the move it rides beside, whichever caused it.
				tone: "effect",
				summary: `${prefix}${humanize(name)} crossed ${detail.rung}`,
				note: cited,
			};
		}
		case "price_crossing": {
			// The item as it read **when the currency passed its price**, resolved the
			// way a rung resolves its term. A later reprice writes a new version this
			// reading never reaches, so a past announcement keeps announcing what it
			// announced — which is the whole of ADR 0017's trust argument, in the one
			// place a sub goes looking for it afterwards.
			const cited =
				describeRewardCitation(
					context.rewards ?? [],
					detail.reward_ref,
					detail.occurred_at,
					context.now ?? detail.occurred_at,
				) ?? detail.reward_ref;
			return {
				tone: "effect",
				summary: `${prefix}${humanize(name)} reached ${detail.price}`,
				note: `${cited} — affordable`,
			};
		}
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
		case "waived":
			// Both halves in one line, phrased through the same `summarizeEffectOp` the
			// confirm sheet lists effects with — the dom reads back exactly the words
			// they unchecked. A reversal appends the move it made, because unlike a
			// suppression it changed a number someone can see.
			return {
				tone: "effect",
				summary: `${prefix}${detail.mechanic === "suppressed" ? "waived" : "reversed"} ${summarizeEffectOp(detail.op)}`,
				note:
					detail.from !== undefined && detail.to !== undefined
						? `${humanize(name)} ${detail.from} → ${detail.to}`
						: undefined,
			};
		case "reversal_declined":
			// Its own tone, not `near_miss`. ADR 0016 borrows the near-miss *shape* — a
			// recorded non-action with a stated cause — and that is as far as the
			// likeness goes: a near-miss says the rule never fired, while this says the
			// effect fired, could not be un-fired, and is still standing. Those are
			// opposite facts about the same counter.
			return {
				tone: "declined",
				summary: `${prefix}could not reverse ${summarizeEffectOp(detail.op)}: ${detail.reason}`,
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
