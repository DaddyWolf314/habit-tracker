import { describe, expect, it } from "vitest";
import {
	effectOpOf,
	planReversal,
	type ReversalPlan,
	standingEffects,
} from "./reversal.ts";
import {
	amendmentCause,
	directCause,
	ruleCause,
	systemJobCause,
	type TraceDetail,
	type TraceRow,
} from "./trace.ts";

/**
 * Reversal (ADR 0016) — the commutativity rule, in isolation.
 *
 * The case these exist for is the one the coarse rule ("counters are
 * reversible") gets wrong, and it is worth stating as an arithmetic: R12 puts
 * demerits at 12, the sub acknowledges and it resets to 0, the dom corrects the
 * ruling, and a naive −2 lands on a screen the sub reads as `demerits: −2`.
 * `applyCounterOp` has no floor, so nothing else stops it.
 */

let nextId = 1;

/** A trace row on `counter:demerits` unless told otherwise. */
function row(
	detail: TraceDetail,
	opts: { projection?: string | null; rule?: string; effect?: number } = {},
): TraceRow {
	const { projection = "counter:demerits", rule = "R12", effect = 0 } = opts;
	return {
		id: nextId++,
		at: 1_000 + nextId,
		cause: ruleCause("e1", rule, effect),
		projection,
		detail,
	};
}

const increment = (by: number, from: number) =>
	row({ kind: "counter", op: "increment", by, from, to: from + by });
const decrement = (by: number, from: number) =>
	row({ kind: "counter", op: "decrement", by, from, to: from - by });

describe("effectOpOf — the effect is read from the trace, not the rule", () => {
	it("reconstructs a counter op from the row that recorded it", () => {
		expect(effectOpOf(increment(2, 10))).toEqual({
			kind: "counter",
			counter: "demerits",
			op: "increment",
			by: 2,
		});
	});

	it("reconstructs anchor, timer and notify ops from their own rows", () => {
		expect(
			effectOpOf(
				row(
					{ kind: "anchor", at: 500, from: null, to: 500 },
					{ projection: "anchor:since_last_orgasm" },
				),
			),
		).toEqual({ kind: "anchor", anchor: "since_last_orgasm", at: 500 });
		expect(
			effectOpOf(
				row(
					{ kind: "timer_close", matched: true, timer_id: "t1" },
					{ projection: "timer:denial_period" },
				),
			),
		).toEqual({ kind: "timer", timer: "denial_period", op: "close" });
		expect(
			effectOpOf(
				row(
					{ kind: "notify", target: "partner" },
					{ projection: "notify:partner" },
				),
			),
		).toEqual({ kind: "notify", target: "partner" });
	});

	it("returns null for a row that records no effect", () => {
		expect(
			effectOpOf(
				row(
					{ kind: "near_miss", reason: "…", awaiting: [] },
					{ projection: null },
				),
			),
		).toBeNull();
	});
});

/**
 * `planReversal` for a row that *does* record an effect. Null is the answer for a
 * row that records none, which every case below except the last one is not — so
 * unwrapping here keeps those cases about commutativity rather than about the
 * nullable return.
 */
function planned(row: TraceRow, later: TraceRow[] = []): ReversalPlan {
	const plan = planReversal(row, later);
	if (plan === null) throw new Error("expected a plan for an effect row");
	return plan;
}

describe("planReversal — reversible exactly when the inverse still commutes", () => {
	it("reverses an increment with nothing in between", () => {
		const plan = planned(increment(2, 10), []);
		expect(plan).toEqual({
			reversible: true,
			effect: { kind: "counter", counter: "demerits", op: "increment", by: 2 },
			compensating: {
				kind: "counter",
				counter: "demerits",
				op: "decrement",
				by: 2,
			},
		});
	});

	it("inverts a decrement too", () => {
		const plan = planned(decrement(3, 10), []);
		expect(plan.reversible && plan.compensating.op).toBe("increment");
	});

	it("is exact across intervening increments and decrements, however many", () => {
		// A compensating delta commutes with other deltas, so the answer does not
		// depend on how many landed in between — which is the whole reason the check
		// is a scan for *non*-commuting rows rather than any arithmetic.
		const target = increment(2, 0);
		const between = [
			increment(1, 2),
			decrement(5, 3),
			increment(7, -2),
			decrement(1, 5),
		];
		const plan = planned(target, between);
		expect(plan.reversible && plan.compensating.by).toBe(2);
	});

	it("declines when the counter was reset in between (the demerits: −2 case)", () => {
		const target = increment(2, 10);
		const acknowledgment: TraceRow = {
			id: nextId++,
			at: 9_999,
			cause: directCause("e-ack"),
			projection: "counter:demerits",
			detail: { kind: "counter", op: "reset", from: 12, to: 0 },
		};
		const plan = planned(target, [acknowledgment]);
		expect(plan.reversible).toBe(false);
		expect(!plan.reversible && plan.reason).toMatch(/reset since/);
	});

	it("declines when a scheduled reset or a streak fold intervened", () => {
		const period: TraceRow = {
			id: nextId++,
			at: 9_999,
			cause: systemJobCause(),
			projection: "counter:demerits",
			detail: { kind: "scheduled_reset", period: "weekly", from: 12, to: 0 },
		};
		expect(planned(increment(2, 10), [period]).reversible).toBe(false);
		const fold: TraceRow = {
			id: nextId++,
			at: 9_999,
			cause: systemJobCause(),
			projection: "counter:demerits",
			detail: {
				kind: "streak_rollover",
				period: "daily",
				target_counter: "demerits",
				met: true,
				from: 3,
				to: 4,
			},
		};
		expect(planned(increment(2, 10), [fold]).reversible).toBe(false);
	});

	it("declines a counter reset — its inverse would clobber what accrued since", () => {
		const plan = planned(
			row({ kind: "counter", op: "reset", from: 12, to: 0 }),
			[],
		);
		expect(plan.reversible).toBe(false);
		expect(!plan.reversible && plan.reason).toMatch(/clobber/);
	});

	it("declines an anchor reset, a timer op, and a notify", () => {
		const anchor = planned(
			row(
				{ kind: "anchor", at: 500, from: 100, to: 500 },
				{ projection: "anchor:since_last_orgasm" },
			),
			[],
		);
		const timer = planned(
			row(
				{ kind: "timer_close", matched: true, timer_id: "t1" },
				{ projection: "timer:denial_period" },
			),
			[],
		);
		const notify = planned(
			row(
				{ kind: "notify", target: "partner" },
				{ projection: "notify:partner" },
			),
			[],
		);
		for (const plan of [anchor, timer, notify]) {
			expect(plan.reversible).toBe(false);
		}
		// Each says which refusal it is, because the couple is meant to be able to
		// see exactly what stayed and talk about it.
		expect(!anchor.reversible && anchor.reason).toMatch(/anchor reset/);
		expect(!timer.reversible && timer.reason).toMatch(/really happened/);
	});

	it("only counts non-commuting rows on the same projection", () => {
		// The caller hands over the window; a reset on a *different* counter is
		// simply not in it. Stated so the seam is not mistaken for a global scan.
		const plan = planned(increment(2, 10), []);
		expect(plan.reversible).toBe(true);
	});

	it("returns null for a row that records no effect, rather than inventing one", () => {
		// A declined plan has to name the effect it declines, and there is none here.
		// Naming one anyway would have the caller write a `reversal_declined` row
		// claiming an effect that never fired — a lie in the ledger, from the
		// mechanism whose entire purpose is keeping the ledger honest.
		expect(
			planReversal(
				row(
					{ kind: "near_miss", reason: "…", awaiting: ["permitted"] },
					{ projection: null },
				),
				[],
			),
		).toBeNull();
	});
});

describe("standingEffects — what is still there to waive", () => {
	it("keeps a landed effect and drops one already waived", () => {
		const landed = increment(2, 0);
		const waived: TraceRow = {
			id: nextId++,
			at: 5_000,
			cause: amendmentCause("e1", "R12", "am1", 0),
			projection: "counter:demerits",
			detail: {
				kind: "waived",
				mechanic: "reversed",
				op: { kind: "counter", counter: "demerits", op: "increment", by: 2 },
				from: 2,
				to: 0,
			},
		};
		expect(standingEffects([landed])).toEqual([landed]);
		expect(standingEffects([landed, waived])).toEqual([]);
	});

	it("a declined reversal spends the effect too — the ledger said it once", () => {
		const landed = row(
			{ kind: "anchor", at: 500, from: null, to: 500 },
			{ projection: "anchor:since_last_orgasm", effect: 1 },
		);
		const declined: TraceRow = {
			id: nextId++,
			at: 5_000,
			cause: amendmentCause("e1", "R12", "am1", 1),
			projection: "anchor:since_last_orgasm",
			detail: {
				kind: "reversal_declined",
				reason: "an anchor reset has no inverse",
				op: { kind: "anchor", anchor: "since_last_orgasm", at: 500 },
			},
		};
		expect(standingEffects([landed, declined])).toEqual([]);
	});

	it("pairs per row, so an effect that fired again is standing again", () => {
		// Correcting a ruling to B and back to A fires A's effect a second time. A
		// set keyed only on `(rule, index)` would treat the fresh effect as already
		// handled by the waiver that overruled the first one, and the dom would find
		// a live effect they cannot touch.
		const first = increment(2, 0);
		const waived: TraceRow = {
			id: nextId++,
			at: 5_000,
			cause: amendmentCause("e1", "R12", "am1", 0),
			projection: "counter:demerits",
			detail: {
				kind: "waived",
				mechanic: "reversed",
				op: { kind: "counter", counter: "demerits", op: "increment", by: 2 },
				from: 2,
				to: 0,
			},
		};
		const second = increment(2, 0);
		expect(standingEffects([first, waived, second])).toEqual([second]);
	});

	it("ignores rows with no effect index — nothing says which effect they were", () => {
		const legacy: TraceRow = {
			id: nextId++,
			at: 1,
			cause: ruleCause("e1", "R2"),
			projection: "counter:demerits",
			detail: { kind: "counter", op: "increment", by: 1, from: 0, to: 1 },
		};
		expect(standingEffects([legacy])).toEqual([]);
	});

	it("ignores near-misses and system jobs", () => {
		const nearMiss = row(
			{ kind: "near_miss", reason: "…", awaiting: ["permitted"] },
			{ projection: null },
		);
		const rollover: TraceRow = {
			id: nextId++,
			at: 1,
			cause: systemJobCause(),
			projection: "counter:demerits",
			detail: { kind: "scheduled_reset", period: "daily", from: 3, to: 0 },
		};
		expect(standingEffects([nearMiss, rollover])).toEqual([]);
	});
});
