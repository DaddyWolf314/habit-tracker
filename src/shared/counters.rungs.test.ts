import { describe, expect, it } from "vitest";
import {
	type CounterRung,
	counterDefinitionSchema,
	rungsCrossed,
	rungsReached,
} from "./counters.ts";

/**
 * The two rung folds (ADR 0015). Between them they decide what gets *announced*
 * and what gets *shown*, and the pair has one property worth stating out loud:
 * a crossing is a moment and a banner is a state, so they are asked different
 * questions and neither is derived from the other. That is what lets a reversal
 * clear the banner while the recorded crossing stays.
 */

const ten: CounterRung = { at: 10, agreement_ref: "ag_ten" };
const five: CounterRung = { at: 5, agreement_ref: "ag_five" };

describe("rungsCrossed", () => {
	it("crosses a rung the move lands exactly on", () => {
		expect(rungsCrossed([ten], 9, 10)).toEqual([ten]);
	});

	it("does not cross a rung the move started at", () => {
		// The half-open low side. Without it, every move above the rung would
		// re-announce it, and "10, reset, 10" would file three rows rather than two.
		expect(rungsCrossed([ten], 10, 12)).toEqual([]);
	});

	it("never crosses downward, or standing still", () => {
		expect(rungsCrossed([ten], 12, 4)).toEqual([]);
		expect(rungsCrossed([ten], 10, 10)).toEqual([]);
		// Including a reset, which is the most common way back down.
		expect(rungsCrossed([ten], 14, 0)).toEqual([]);
	});

	it("returns every rung one move passes, lowest first", () => {
		// Each names a different term the couple agreed, so one row cannot stand in
		// for the other — and the order is the order they were passed in.
		expect(rungsCrossed([ten, five], 0, 11)).toEqual([five, ten]);
	});

	it("has nothing to say about an empty ladder", () => {
		expect(rungsCrossed([], 0, 100)).toEqual([]);
	});
});

describe("rungsReached", () => {
	it("holds while the counter sits at or above, highest first", () => {
		expect(rungsReached([five, ten], 10)).toEqual([ten, five]);
		expect(rungsReached([five, ten], 5)).toEqual([five]);
	});

	it("clears as soon as the counter drops below", () => {
		// The banner is derived from the value, never from the crossing rows, which
		// is what makes a reset, an acknowledgment, a decrement and a reversal all
		// clear it without any of them being special-cased.
		expect(rungsReached([five, ten], 4)).toEqual([]);
	});
});

describe("counterDefinitionSchema.rungs", () => {
	it("defaults to an empty ladder, so a counter written before rungs reads as one", () => {
		const parsed = counterDefinitionSchema.parse({
			id: "demerits",
			name: "Demerits",
		});
		expect(parsed.rungs).toEqual([]);
	});

	it("refuses a rung citing nothing", () => {
		// A rung is a number *and* a term (ADR 0006): half of one would announce a
		// crossing with no consequence attached.
		expect(() =>
			counterDefinitionSchema.parse({
				id: "demerits",
				name: "Demerits",
				rungs: [{ at: 10, agreement_ref: "" }],
			}),
		).toThrow();
	});
});
