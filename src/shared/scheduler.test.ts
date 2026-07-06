import { describe, expect, it } from "vitest";
import { catchUpFireAt, dueItems, earliestFireAt } from "./scheduler.ts";

describe("earliest fire (handoff §3.2 — arm the single alarm at MIN)", () => {
	it("is the minimum fire time across scheduled items", () => {
		expect(earliestFireAt([5_000, 2_000, 9_000])).toBe(2_000);
	});

	it("is null when nothing is scheduled (a dormant couple arms no alarm)", () => {
		expect(earliestFireAt([])).toBeNull();
	});

	it("ignores absent fire times (a paused countdown contributes none)", () => {
		expect(earliestFireAt([null, 7_000, undefined])).toBe(7_000);
		expect(earliestFireAt([null, undefined])).toBeNull();
	});
});

describe("due selection (handoff §3.2 — on fire, process everything due)", () => {
	const items = [
		{ id: "a", next_fire_at: 1_000 },
		{ id: "b", next_fire_at: 2_000 },
		{ id: "c", next_fire_at: 3_000 },
	];

	it("selects every item whose fire time has arrived (inclusive)", () => {
		expect(dueItems(items, 2_000).map((i) => i.id)).toEqual(["a", "b"]);
	});

	it("selects nothing before the earliest fire", () => {
		expect(dueItems(items, 500)).toEqual([]);
	});
});

describe("recurrence catch-up (handoff §3.2 — reschedule after firing)", () => {
	const DAY = 86_400_000;

	it("advances one interval when firing exactly on time", () => {
		expect(catchUpFireAt(1_000, DAY, 1_000)).toBe(1_000 + DAY);
	});

	it("skips missed periods on a long-dormant couple, landing strictly ahead", () => {
		// Scheduled daily from t=0, woken 3.5 days later: the next fire is day 4, not
		// a burst of four catch-up fires. One reschedule, always in the future.
		const next = catchUpFireAt(0, DAY, 3 * DAY + DAY / 2);
		expect(next).toBe(4 * DAY);
		expect(next).toBeGreaterThan(3 * DAY + DAY / 2);
	});

	it("leaves a not-yet-due fire untouched", () => {
		expect(catchUpFireAt(5_000, DAY, 1_000)).toBe(5_000);
	});

	it("guards a non-positive interval (a one-shot never recurs)", () => {
		expect(catchUpFireAt(1_000, 0, 9_000)).toBe(1_000);
	});
});
