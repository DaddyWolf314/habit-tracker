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
