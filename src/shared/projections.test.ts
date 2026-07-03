import { describe, expect, it } from "vitest";
import { ulid } from "#/lib/ulid.ts";
import {
	COUNTER_ADJUSTED_TYPE,
	COUNTER_RESET_TYPE,
} from "#/templates/index.ts";
import type { Amendment } from "./amendments.ts";
import {
	applyCounterEvent,
	type CounterEventInput,
	compositeMetadata,
	isPending,
	replayCounterValue,
} from "./projections.ts";

function adjust(counter: string, delta: number, at: number): CounterEventInput {
	return {
		type: COUNTER_ADJUSTED_TYPE,
		logged_at: at,
		id: ulid(at),
		metadata: { counter, delta },
	};
}

describe("counter projection", () => {
	it("folds adjustments and resets", () => {
		expect(applyCounterEvent(3, adjust("c", 2, 1))).toBe(5);
		expect(applyCounterEvent(3, adjust("c", -1, 1))).toBe(2);
		expect(
			applyCounterEvent(9, {
				type: COUNTER_RESET_TYPE,
				logged_at: 1,
				id: "x",
				metadata: { counter: "c" },
			}),
		).toBe(0);
	});

	it("ignores non-counter and other-counter events on replay", () => {
		const events: CounterEventInput[] = [
			adjust("demerits", 2, 10),
			adjust("praise", 5, 11),
			adjust("demerits", 1, 12),
			{ type: "note", logged_at: 13, id: ulid(13), metadata: {} },
		];
		expect(replayCounterValue("demerits", events)).toBe(3);
		expect(replayCounterValue("praise", events)).toBe(5);
	});

	it("replay reproduces the incrementally-applied value, resets included", () => {
		const events = [
			adjust("c", 1, 1),
			adjust("c", 1, 2),
			{
				type: COUNTER_RESET_TYPE,
				logged_at: 3,
				id: ulid(3),
				metadata: { counter: "c" },
			},
			adjust("c", 4, 4),
		];
		// Incremental application in append order.
		let live = 0;
		for (const e of events) live = applyCounterEvent(live, e);
		expect(replayCounterValue("c", events)).toBe(live);
		expect(live).toBe(4);
	});

	it("replay is order-independent of input array (sorts by logged_at)", () => {
		const events = [adjust("c", 5, 30), adjust("c", 2, 10), adjust("c", 3, 20)];
		expect(replayCounterValue("c", events)).toBe(10);
		expect(replayCounterValue("c", [...events].reverse())).toBe(10);
	});
});

describe("composite state + pending", () => {
	const base = { metadata: { outcome: "full" } };

	it("with no amendments, composite equals the original", () => {
		expect(compositeMetadata(base, [])).toEqual({ outcome: "full" });
	});

	it("overlays adjudications in created_at order, respecting supersedes", () => {
		const amendments: Amendment[] = [
			{
				kind: "adjudication",
				id: "a1",
				target_event_id: "e",
				actor: "d",
				created_at: 1,
				patch: { permitted: false },
			},
			{
				kind: "adjudication",
				id: "a2",
				target_event_id: "e",
				actor: "d",
				created_at: 2,
				patch: { permitted: true },
				supersedes: "a1",
			},
		];
		expect(compositeMetadata(base, amendments)).toEqual({
			outcome: "full",
			permitted: true,
		});
	});

	it("is pending while an awaiting key is unset, resolved once present", () => {
		const type = { awaiting: ["permitted"] };
		expect(isPending(type, { outcome: "full" })).toBe(true);
		expect(isPending(type, { outcome: "full", permitted: true })).toBe(false);
		expect(isPending(type, { outcome: "full" }, true)).toBe(false); // retracted
	});
});

describe("ulid", () => {
	it("is 26 chars and lexicographically sorts by time", () => {
		const a = ulid(1000);
		const b = ulid(2000);
		expect(a).toHaveLength(26);
		expect(b).toHaveLength(26);
		expect(a < b).toBe(true);
	});
});
