import { type WaivedEffect, waivedEffectKey } from "./amendments.ts";
import type { EffectOp } from "./engine.ts";
import { humanize, projectionName, type TraceRow } from "./trace.ts";

/**
 * Reversal (ADR 0016) — deciding whether an effect that already landed can be
 * un-fired, and what the compensating move is. Pure and dependency-free like
 * `engine.ts`, so the DO's live path, its rebuild, and any surface that wants to
 * say "this one can't be undone" before the dom taps all answer from one place.
 *
 * The rule is a property, not a list of reversible verbs: **an effect is
 * reversible exactly when its inverse still commutes with everything that has
 * happened since.** "Counters are reversible" was the coarse version, and the
 * case it misses puts a lie on a screen the sub reads —
 *
 * ```
 * R12 fires            → demerits +2   (demerits: 12)
 * sub acknowledges     → reset          (demerits:  0)
 * dom corrects ruling  → reverse −2     (demerits: −2)
 * ```
 *
 * `applyCounterOp` has no floor, so that number lands: the punishment had already
 * been discharged and the reversal subtracted it from nothing.
 *
 * Two things make the check cheap. A compensating delta commutes with other
 * increments and decrements, so reversing *across* them is exact however many
 * intervened and the scan never has to arithmetic anything. And the trace already
 * holds every counter move with `from`/`to`, so "has anything non-commuting
 * touched this counter since" is a query over rows this module is handed — no new
 * table, and on a rebuild the same query runs against the trace the replay is
 * itself rebuilding.
 *
 * Everything that is not a counter increment or decrement is *never* reversible.
 * That is not a new refusal: a counter reset's inverse would clobber whatever
 * accrued since, an anchor reset has no memory of what it displaced, and a closed
 * countdown has no honest inverse — `couple-do.ts` has declined retroactive timer
 * surgery since Phase 4. Each files a `reversal_declined` row instead, which is
 * what lets a correction always land.
 */

/** A counter effect, narrowed — the only shape a reversal is ever planned for. */
type CounterEffect = Extract<EffectOp, { kind: "counter" }>;

/**
 * What to do about one landed effect: undo it exactly, or say why not. The
 * reversible arm is narrowed to counters in the *type*, not merely by the
 * branches below — the caller applies `compensating` through `applyCounterOp`,
 * and there is deliberately no way to hand it anything else.
 */
export type ReversalPlan =
	/** `compensating` is the op to apply; `effect` is what it undoes. */
	| { reversible: true; effect: CounterEffect; compensating: CounterEffect }
	| { reversible: false; effect: EffectOp; reason: string };

/**
 * The effect a trace row recorded, reconstructed **from the row itself**.
 *
 * This is the load-bearing half of "read the effects from the trace, never
 * re-derive them from the rule" (ADR 0002, ADR 0016). A rule edited since it
 * fired would hand back a different effects list, and reversing that list would
 * undo something the couple never received. Returns null for a row that records
 * no effect at all — a near-miss, a system job, or a waiver row itself, none of
 * which is a thing to un-fire.
 */
export function effectOpOf(row: TraceRow): EffectOp | null {
	const name = projectionName(row.projection);
	switch (row.detail.kind) {
		case "counter":
			return {
				kind: "counter",
				counter: name,
				op: row.detail.op,
				by: row.detail.by,
			};
		case "anchor":
			return { kind: "anchor", anchor: name, at: row.detail.at };
		case "timer_open":
			return { kind: "timer", timer: name, op: "open" };
		case "timer_close":
			return { kind: "timer", timer: name, op: "close" };
		case "notify":
			return { kind: "notify", target: name };
		default:
			return null;
	}
}

/**
 * The `(rule, effect_index)` pair a trace row belongs to — the identity a waiver
 * names — or null when the row cannot be named by one.
 *
 * Null is the answer for a system job or a direct manipulation (no rule caused
 * it), and for a row written before the effect index was recorded: nothing says
 * which effect of the rule it was, and inventing an index by re-reading today's
 * definition is the re-derivation ADR 0016 forbids. The one place that judgement
 * is made, so a caller cannot quietly default it to effect 0.
 */
export function waivedEffectOf(row: TraceRow): WaivedEffect | null {
	const cause = row.cause;
	if (cause.by !== "rule" && cause.by !== "amendment") return null;
	if (cause.effect_index === undefined) return null;
	return { rule_id: cause.rule, effect_index: cause.effect_index };
}

/**
 * The rows of an event's trace that record an effect **still standing** — landed,
 * and not already overruled by a waiver or refused by a `reversal_declined`.
 *
 * Shared by the DO (which reverses them) and the log's chain view (which offers
 * them), because "may this be waived" has to be one question: a surface with its
 * own answer would offer a button whose write is refused, or hide one that would
 * have worked.
 *
 * The pairing is per *row*, not per `(rule, index)`, and the difference is
 * load-bearing. Correcting a ruling to B and back to A fires A's effect a second
 * time; a set keyed only on the index would treat the fresh effect as already
 * handled by the waiver that overruled the first one. So the rows are walked in
 * order and each overruling row consumes the oldest standing effect at its
 * index — the pairing the live sequence actually made, and the one a replay
 * reproduces.
 */
export function standingEffects(rows: TraceRow[]): TraceRow[] {
	const standing = new Map<string, TraceRow[]>();
	for (const row of [...rows].sort((a, b) => a.id - b.id)) {
		const named = waivedEffectOf(row);
		if (named === null) continue;
		const key = waivedEffectKey(named);
		const queue = standing.get(key) ?? [];
		if (
			row.detail.kind === "waived" ||
			row.detail.kind === "reversal_declined"
		) {
			queue.shift();
		} else if (effectOpOf(row) !== null) {
			queue.push(row);
		}
		standing.set(key, queue);
	}
	return [...standing.values()].flat().sort((a, b) => a.id - b.id);
}

/**
 * Whether a row on the same projection breaks commutativity for an earlier
 * counter delta. A reset — whether a rule wrote it, the sub's acknowledgment
 * logged it as the `counter_reset` sugar, or the calendar fired it — discards the
 * value the delta was part of, and a streak fold reads the counter and writes a
 * different one on the strength of it. Nothing after such a row can be told what
 * the delta contributed, so its inverse is no longer a subtraction from the same
 * number.
 *
 * Everything else on a counter is a delta, and deltas commute: the reversal is
 * exact across any number of them. A `waived` row is one too when it carries a
 * compensating move, and nothing at all when it was a suppression.
 */
function breaksCommutation(row: TraceRow): boolean {
	switch (row.detail.kind) {
		case "counter":
			return row.detail.op === "reset";
		case "scheduled_reset":
		case "streak_rollover":
			return true;
		default:
			return false;
	}
}

/**
 * The word for what intervened, so the declined row says which of the three it
 * was rather than "something happened" — the couple is meant to be able to talk
 * about what stayed.
 */
function blockerReason(row: TraceRow, counter: string): string {
	const name = humanize(counter);
	switch (row.detail.kind) {
		case "scheduled_reset":
			return `${name} was reset for the ${row.detail.period} period since`;
		case "streak_rollover":
			return `a streak folded ${name} since`;
		default:
			return `${name} was reset since`;
	}
}

/**
 * Plans the reversal of one landed effect. `later` is every trace row on the same
 * projection that was written after it, oldest first — the caller's query, since
 * only the caller knows whether it is reading the live trace or the one a replay
 * is rebuilding.
 */
export function planReversal(row: TraceRow, later: TraceRow[]): ReversalPlan {
	const effect = effectOpOf(row);
	if (effect === null) {
		return {
			reversible: false,
			effect: { kind: "notify", target: projectionName(row.projection) },
			reason: "this row records no effect to reverse",
		};
	}
	if (effect.kind === "anchor") {
		return {
			reversible: false,
			effect,
			reason:
				"an anchor reset has no inverse — nothing records what it displaced",
		};
	}
	if (effect.kind === "timer") {
		return {
			reversible: false,
			effect,
			reason: `a timer ${effect.op === "open" ? "open" : "close"} has no inverse — the span it measured really happened`,
		};
	}
	if (effect.kind === "notify") {
		return {
			reversible: false,
			effect,
			reason: "a notification has already been delivered",
		};
	}
	if (effect.op === "reset") {
		return {
			reversible: false,
			effect,
			reason:
				"a counter reset has no inverse — restoring it would clobber whatever accrued since",
		};
	}
	const blocker = later.find(breaksCommutation);
	if (blocker) {
		return {
			reversible: false,
			effect,
			reason: `${blockerReason(blocker, effect.counter)}, so the inverse no longer commutes`,
		};
	}
	return {
		reversible: true,
		effect,
		compensating: {
			kind: "counter",
			counter: effect.counter,
			op: effect.op === "increment" ? "decrement" : "increment",
			by: effect.by ?? 1,
		},
	};
}
