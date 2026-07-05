/**
 * The single-alarm scheduler (handoff §3.2) — pure, dependency-free decisions for
 * the DO's internal schedule. Cloudflare gives a Durable Object exactly one alarm,
 * so instead of cron each DO keeps a small `schedule` table and always arms that
 * one alarm at `MIN(next_fire_at)`; on fire it processes everything due and
 * reschedules. A dormant couple has an empty schedule and so arms nothing — it
 * costs nothing. These functions are the mechanism; what a fired job *does*
 * (counter resets, streak evaluation) is wired in the DO with #33.
 *
 * Kept isomorphic and unit-testable in plain Node, like `timers.ts`/`anchors.ts`.
 */

/**
 * The earliest fire time to arm the single alarm at (handoff §3.2 — `MIN`), or
 * null when nothing is scheduled (arm no alarm). Absent times are ignored so a
 * source with no pending fire — a paused countdown, a couple with no resets —
 * contributes nothing rather than forcing a spurious wake.
 */
export function earliestFireAt(
	times: readonly (number | null | undefined)[],
): number | null {
	const pending = times.filter((t): t is number => typeof t === "number");
	return pending.length > 0 ? Math.min(...pending) : null;
}

/**
 * The scheduled items whose fire time has arrived as of `now` (handoff §3.2 — on
 * fire, process *everything* due, not just the one that tripped the alarm, so a
 * single wake drains the backlog). Inclusive: an item due exactly at `now` fires.
 */
export function dueItems<T extends { next_fire_at: number }>(
	items: readonly T[],
	now: number,
): T[] {
	return items.filter((item) => item.next_fire_at <= now);
}

/**
 * The next fire time for a recurring item after it fires (handoff §3.2 —
 * reschedule). Advances by whole `intervalMs` steps to the first time strictly
 * after `now`, so a couple dormant across many periods gets one catch-up fire
 * landing in the future, never a burst of missed fires replayed at once. A
 * non-positive interval is a one-shot (never recurs): its time is returned
 * unchanged for the caller to delete instead of rescheduling.
 */
export function catchUpFireAt(
	next_fire_at: number,
	intervalMs: number,
	now: number,
): number {
	if (intervalMs <= 0) return next_fire_at;
	if (next_fire_at > now) return next_fire_at;
	const missed = Math.floor((now - next_fire_at) / intervalMs) + 1;
	return next_fire_at + missed * intervalMs;
}
