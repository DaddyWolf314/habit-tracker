/**
 * Streak rollover + scheduled resets (handoff §4.4, §3.2) — pure, dependency-free
 * decisions the DO alarm applies at a day/week rollover. Streaks are built into
 * target-counters, *not* rules ("rules react to events; schedules belong to
 * projection definitions"): at rollover the alarm asks "target met? streak +1 :
 * streak = 0" and, separately, clears the counters whose reset cadence has come
 * due. Kept isomorphic and unit-testable in plain Node, like `scheduler.ts`.
 */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** 1970-01-01 (the epoch) was a Thursday, so the first Monday 00:00 UTC is +4 days. */
const MONDAY_EPOCH_MS = 4 * DAY_MS;

/**
 * Whether a target-counter met its target for the period just closed (handoff
 * §4.4). A counter with no target never streaks — the gate is simply unmet — so a
 * plain tally can share the rollover machinery without accidentally counting.
 */
export function targetMet(
	value: number,
	target: number | null | undefined,
): boolean {
	return typeof target === "number" && value >= target;
}

/** The streak after a rollover: continued (+1) on a met period, broken (0) otherwise. */
export function nextStreak(current: number, met: boolean): number {
	return met ? current + 1 : 0;
}

/**
 * The next daily rollover — the coming UTC midnight, strictly after `now`. Aligned
 * to the day grid so adding {@link DAY_MS} to reschedule lands on the next midnight
 * (UTC has no DST), letting the scheduler recur it by a fixed interval.
 */
export function nextDailyRollover(now: number): number {
	return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

/**
 * The next weekly rollover — the coming Monday 00:00 UTC, strictly after `now`.
 * Anchored to the first Monday after the epoch so, like the daily boundary, adding
 * {@link WEEK_MS} stays Monday-aligned for fixed-interval rescheduling.
 */
export function nextWeeklyRollover(now: number): number {
	const weeksSince = Math.floor((now - MONDAY_EPOCH_MS) / WEEK_MS);
	return MONDAY_EPOCH_MS + (weeksSince + 1) * WEEK_MS;
}
