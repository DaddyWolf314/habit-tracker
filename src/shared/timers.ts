import { z } from "zod";
import { type MetadataValue, metadataValueSchema } from "./roles.ts";

/**
 * Timer projections (handoff §4.5) — pure, dependency-free state machines for the
 * three timer flavors, kept isomorphic (no storage/runtime deps) so the Durable
 * Object and the client agree exactly and it is unit-testable in plain Node,
 * exactly like `engine.ts` and `projections.ts`. The DO owns the in-flight rows;
 * these functions decide the transitions.
 *
 * This module covers stopwatches (accumulating, paired open/close) and countdowns
 * (deadline timers with dom pause/extend). Elapsed-since anchors live in
 * `anchors.ts`; the schedule that fires over-max auto-closes and countdown
 * expiries lives in `scheduler.ts`.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Default per-activity max run time for a stopwatch before the alarm auto-closes
 * it flagged for review (handoff §4.5). Tags with no entry fall back to
 * {@link DEFAULT_STOPWATCH_MAX_MS}. Policy defaults; a per-couple override surface
 * is a later concern.
 */
export const STOPWATCH_MAX_MS_BY_ACTIVITY: Record<string, number> = {
	kneeling: 6 * HOUR_MS,
	service: 12 * HOUR_MS,
	wear: 24 * HOUR_MS,
	scene: 12 * HOUR_MS,
};

/** Fallback max for a stopwatch whose activity has no configured limit. */
export const DEFAULT_STOPWATCH_MAX_MS: number = 12 * HOUR_MS;

/** Timer flavors that live in the `timers` table (anchors are separate). */
export const timerKindSchema = z.enum(["stopwatch", "countdown"]);
export type TimerKind = z.infer<typeof timerKindSchema>;

/** What the dom sends to extend a countdown — the extra time to grant. */
export const extendTimerInputSchema = z.object({
	by_ms: z.number().int().positive(),
});
export type ExtendTimerInput = z.infer<typeof extendTimerInputSchema>;

/**
 * A timer as returned to clients (handoff §4.5, §9 today view). A running timer
 * has `status: null`; `duration_ms` is present once derived on close. Countdown
 * fields (`deadline_at`, `paused_at`, `remaining_ms`) fill in with #30.
 */
export const timerViewSchema = z.object({
	id: z.string(),
	kind: timerKindSchema,
	/** The timer definition name, e.g. `session_stopwatch` / `task_countdown`. */
	timer: z.string(),
	tag: z.string().nullable(),
	match: z.record(z.string(), metadataValueSchema),
	opened_at: z.number().int().nullable(),
	closed_at: z.number().int().nullable(),
	/** null while running; a terminal disposition once closed. */
	status: z.string().nullable(),
	duration_ms: z.number().int().nullable(),
	deadline_at: z.number().int().nullable(),
	paused_at: z.number().int().nullable(),
	remaining_ms: z.number().int().nullable(),
});
export type TimerView = z.infer<typeof timerViewSchema>;

// ── Stopwatches (accumulating) — handoff §4.5 ──────────────────────────────────

/**
 * An open (in-flight) stopwatch. `match` is the resolved ref match the opening
 * event pinned (e.g. `{ session_id: "s1" }`, from R15's `session_id`); a close
 * finds its open by that match. `tag` is the opening `activity`, carried so the
 * per-activity max and duration routing (R16) can read it.
 */
export interface OpenStopwatch {
	id: string;
	/** The timer definition name, e.g. `session_stopwatch`. */
	timer: string;
	match: Record<string, MetadataValue>;
	opened_at: number;
	tag?: string;
}

/** A stopwatch after close, with its derived duration and disposition. */
export interface ClosedStopwatch extends OpenStopwatch {
	closed_at: number;
	duration_ms: number;
	status: "completed" | "auto_closed";
	flagged_for_review: boolean;
}

/**
 * The derived duration of a stopwatch (handoff §4.5 — "duration derived on
 * close"). Clamped at 0 so a close backdated before its open can never produce a
 * negative span; the rule that routes this value never computes it (handoff §4.3).
 */
export function stopwatchDurationMs(
	opened_at: number,
	closed_at: number,
): number {
	return Math.max(0, closed_at - opened_at);
}

/** Whole floored minutes of a millisecond span — the unit `service_minutes_week` counts. */
export function durationMinutes(durationMs: number): number {
	return Math.floor(durationMs / MINUTE_MS);
}

/**
 * A remaining-time span rendered for the today view: the two largest non-zero
 * units, coarsening as the span grows (`1d 1h`, `1h 2m`, `1m 30s`, `45s`).
 * Isomorphic and pure so the client can tick it every second off
 * {@link countdownRemainingMs}. Negative/zero clamps to `0s` — an overdue
 * countdown reads as done, never as negative time.
 */
export function formatRemaining(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * Finds the open stopwatch a close refers to, by matching every key in the
 * resolved `match_on` (handoff §4.5 — "ended with no matching started → reject").
 * An empty/absent match pins no key and so matches *nothing* (never all opens):
 * `engine.resolveMatchOn` drops keys the close event left unset, so a close that
 * failed to carry its `session_id` must be treated as an orphan, not as a
 * wildcard that would close an unrelated session.
 */
export function matchStopwatch(
	opens: OpenStopwatch[],
	matchOn: Record<string, MetadataValue> | undefined,
): OpenStopwatch | undefined {
	const keys = matchOn ? Object.keys(matchOn) : [];
	if (keys.length === 0) return undefined;
	return opens.find((sw) => keys.every((k) => sw.match[k] === matchOn?.[k]));
}

/**
 * Closes a stopwatch, deriving its duration. An `auto` close is the over-max
 * sweep (handoff §4.5 — "session left running past a per-activity max →
 * auto-close flagged for review"); a normal close is a matched `session_ended`.
 */
export function closeStopwatch(
	open: OpenStopwatch,
	closed_at: number,
	opts: { auto?: boolean } = {},
): ClosedStopwatch {
	return {
		...open,
		closed_at,
		duration_ms: stopwatchDurationMs(open.opened_at, closed_at),
		status: opts.auto ? "auto_closed" : "completed",
		flagged_for_review: opts.auto === true,
	};
}

/**
 * Selects the open stopwatches that have run past their per-activity max as of
 * `now` and must be auto-closed (handoff §4.5). The limit is looked up by `tag`
 * (activity), falling back to `defaultMaxMs` for tags with no configured limit.
 */
export function stopwatchesToAutoClose(
	opens: OpenStopwatch[],
	now: number,
	maxMsByTag: Record<string, number>,
	defaultMaxMs: number,
): OpenStopwatch[] {
	return opens.filter(
		(sw) => now - sw.opened_at >= stopwatchMax(sw, maxMsByTag, defaultMaxMs),
	);
}

/** The next timestamp an open stopwatch would hit its max (for the alarm to arm). */
export function stopwatchExpiryAt(
	open: OpenStopwatch,
	maxMsByTag: Record<string, number>,
	defaultMaxMs: number,
): number {
	return open.opened_at + stopwatchMax(open, maxMsByTag, defaultMaxMs);
}

function stopwatchMax(
	open: OpenStopwatch,
	maxMsByTag: Record<string, number>,
	defaultMaxMs: number,
): number {
	const tagged = open.tag !== undefined ? maxMsByTag[open.tag] : undefined;
	return tagged ?? defaultMaxMs;
}

// ── Countdowns (deadline) — handoff §4.5 ───────────────────────────────────────

/**
 * An in-flight countdown (handoff §4.5). Created at assignment with a `deadline_at`;
 * the dom may pause it — freezing `remaining_ms` and stamping `paused_at` — and
 * extend it. Life intrudes, and rigid timers punish people for having jobs, so
 * pause/extend are day-one. Terminal `completed`/`failed` come from a rule close;
 * `expired` from the alarm when a running countdown passes its deadline unresolved.
 */
export interface Countdown {
	opened_at: number;
	deadline_at: number;
	/** Set while paused; the clock is frozen and cannot expire. */
	paused_at?: number | null;
	/** Time left, captured at pause; re-projected onto a fresh deadline on resume. */
	remaining_ms?: number | null;
}

/** Whether a countdown is currently paused (clock frozen). */
function isPaused(c: Countdown): boolean {
	return c.paused_at !== undefined && c.paused_at !== null;
}

/**
 * Time left on a countdown as of `now`. While paused this is the frozen
 * `remaining_ms`; while running it counts toward the deadline, clamped at 0 so an
 * overdue countdown reads as done, never negative.
 */
export function countdownRemainingMs(c: Countdown, now: number): number {
	if (isPaused(c)) return Math.max(0, c.remaining_ms ?? 0);
	return Math.max(0, c.deadline_at - now);
}

/**
 * Whether a running countdown has passed its deadline and should be marked
 * `expired` (handoff §4.5 — the future-consequence hook). A paused countdown
 * never expires: pausing is exactly the "life intruded" escape valve.
 */
export function isCountdownExpired(c: Countdown, now: number): boolean {
	return !isPaused(c) && now >= c.deadline_at;
}

/** Pauses a running countdown, freezing the time that was left at `now`. */
export function pauseCountdown(
	c: Countdown,
	now: number,
): { paused_at: number; remaining_ms: number } {
	return { paused_at: now, remaining_ms: Math.max(0, c.deadline_at - now) };
}

/**
 * Resumes a paused countdown at `now`, re-projecting the frozen remaining time
 * onto a fresh deadline so the pause added no cost and stole no time.
 */
export function resumeCountdown(
	c: Countdown,
	now: number,
): { deadline_at: number; paused_at: null; remaining_ms: null } {
	return {
		deadline_at: now + Math.max(0, c.remaining_ms ?? 0),
		paused_at: null,
		remaining_ms: null,
	};
}

/**
 * Extends a countdown by `byMs`. While running the deadline moves out; while
 * paused the frozen remaining grows (re-projected onto a deadline on resume).
 */
export function extendCountdown(
	c: Countdown,
	byMs: number,
): { deadline_at: number } | { remaining_ms: number } {
	return isPaused(c)
		? { remaining_ms: Math.max(0, (c.remaining_ms ?? 0) + byMs) }
		: { deadline_at: c.deadline_at + byMs };
}

/**
 * The timestamp the alarm should fire to expire this countdown, or null while
 * paused (a paused countdown has no scheduled expiry). Feeds the single-alarm
 * scheduler (#32).
 */
export function countdownExpiryAt(c: Countdown): number | null {
	return isPaused(c) ? null : c.deadline_at;
}

/**
 * Re-projects a running countdown across a global pause-everything (#40): the
 * paused wall-clock duration is added back to the deadline so the safeword
 * freeze stole no time and the countdown resumes with exactly the remaining it
 * had. A countdown that was *individually* paused (its own clock already frozen)
 * has no live deadline to shift, so it is returned as `null` and left untouched —
 * global resume must not un-pause what the dom paused by hand.
 */
export function reprojectAcrossPause(
	c: Countdown,
	pausedMs: number,
): { deadline_at: number } | null {
	if (isPaused(c)) return null;
	return { deadline_at: c.deadline_at + pausedMs };
}
