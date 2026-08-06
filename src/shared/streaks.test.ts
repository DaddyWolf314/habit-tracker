import { describe, expect, it } from "vitest";
import {
	DAY_MS,
	nextDailyRollover,
	nextStreak,
	nextWeeklyRollover,
	targetMet,
	WEEK_MS,
} from "./streaks.ts";

describe("target met (handoff §4.4 — streaks built into target-counters)", () => {
	it("is met when the value reaches the target", () => {
		expect(targetMet(1, 1)).toBe(true);
		expect(targetMet(3, 2)).toBe(true);
	});

	it("is unmet below the target", () => {
		expect(targetMet(0, 1)).toBe(false);
	});

	it("is never met when the counter has no target (it cannot streak)", () => {
		expect(targetMet(5, undefined)).toBe(false);
		expect(targetMet(5, null)).toBe(false);
	});

	it("defaults to a floor, so a bare call reads as it always did", () => {
		expect(targetMet(1, 1)).toBe(targetMet(1, 1, "floor"));
	});

	/**
	 * A cap is the mercy shape (ADR 0015): met by staying *under* the target, which
	 * is what makes a target of 0 mean "a period with none of these" and turns a
	 * clean streak into an ordinary counter a `counter_value` clause can read.
	 */
	it("is met by staying under a cap", () => {
		expect(targetMet(0, 0, "cap")).toBe(true);
		expect(targetMet(1, 2, "cap")).toBe(true);
		expect(targetMet(2, 2, "cap")).toBe(true);
	});

	it("breaks a cap the moment the value exceeds it", () => {
		expect(targetMet(1, 0, "cap")).toBe(false);
		expect(targetMet(3, 2, "cap")).toBe(false);
	});

	it("still never streaks a capped counter with no target", () => {
		// The absent-target gate comes first, whichever direction is asked for —
		// otherwise every plain tally would fold a streak by accident.
		expect(targetMet(0, undefined, "cap")).toBe(false);
	});
});

describe("streak rollover (handoff §4.4 — target met? +1 : 0)", () => {
	it("increments the streak on a met day", () => {
		expect(nextStreak(4, true)).toBe(5);
	});

	it("resets the streak to zero on a missed day", () => {
		expect(nextStreak(9, false)).toBe(0);
	});
});

describe("rollover boundaries (handoff §3.2 — alarm fires at day/week rollover)", () => {
	it("daily rollover is the next UTC midnight, strictly ahead", () => {
		expect(nextDailyRollover(0)).toBe(DAY_MS);
		expect(nextDailyRollover(DAY_MS)).toBe(2 * DAY_MS);
		expect(nextDailyRollover(DAY_MS + 5_000)).toBe(2 * DAY_MS);
	});

	it("weekly rollover is the next Monday 00:00 UTC", () => {
		// 1970-01-01 (epoch) was a Thursday; the first Monday is day 4.
		const firstMonday = 4 * DAY_MS;
		expect(nextWeeklyRollover(0)).toBe(firstMonday);
		expect(nextWeeklyRollover(firstMonday)).toBe(firstMonday + WEEK_MS);
		expect(nextWeeklyRollover(firstMonday - 1)).toBe(firstMonday);
	});

	it("advancing a rollover by its interval stays aligned to the boundary", () => {
		// Why the scheduler can reschedule rollovers by a fixed interval: a boundary
		// plus DAY_MS/WEEK_MS is still a boundary (UTC has no DST), so catch-up keeps
		// midnight/Monday alignment without recomputing the calendar each fire.
		expect(nextDailyRollover(0) + DAY_MS).toBe(nextDailyRollover(DAY_MS));
		expect(nextWeeklyRollover(0) + WEEK_MS).toBe(
			nextWeeklyRollover(4 * DAY_MS),
		);
	});
});
