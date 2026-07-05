import { z } from "zod";

/**
 * Elapsed-since anchors (handoff §4.5, §4.2) — the "days since last infraction"
 * projection. An anchor is the simplest projection there is: a single `since`
 * timestamp, reset by a rule effect (R7/R11/R12/R17). The live "days since"
 * display is derived on the client, ticking against `since`; the DO stores only
 * the timestamp. Pure and dependency-free, isomorphic like `timers.ts`, so the
 * DO and client agree and it is unit-testable in plain Node.
 */

const DAY_MS = 86_400_000;

/**
 * Folds a reset into an anchor (handoff §4.2 — time-anchored to the event's
 * `occurred_at`, not the log time). Takes the *later* of the current and the
 * resetting timestamp so the anchor tracks the most recent qualifying event: a
 * backdated amendment older than the last real event must not drag "since last
 * infraction" backward. Folding by max is commutative, so a `rebuildCounters`
 * replay lands the same value regardless of the order it re-applies the log.
 */
export function resetAnchor(current: number | null, at: number): number {
	return current === null ? at : Math.max(current, at);
}

/**
 * Elapsed time since the anchor as of `now`, or null when the anchor has never
 * been reset (nothing to count from — the display shows "—", not "0 days").
 * Clamped at 0 so a clock behind the anchor never reads negative.
 */
export function anchorElapsedMs(
	since: number | null,
	now: number,
): number | null {
	return since === null ? null : Math.max(0, now - since);
}

/** Whole floored days of an elapsed span (null stays null) — the "days since" unit. */
export function anchorElapsedDays(elapsedMs: number | null): number | null {
	return elapsedMs === null ? null : Math.floor(elapsedMs / DAY_MS);
}

/**
 * An anchor as returned to clients (handoff §4.5, §9 today view). `since` is the
 * stored timestamp; `elapsed_ms`/`elapsed_days` are a snapshot at read time that
 * the client keeps ticking live against `since`.
 */
export const anchorViewSchema = z.object({
	anchor: z.string(),
	since: z.number().int().nullable(),
	elapsed_ms: z.number().int().nullable(),
	elapsed_days: z.number().int().nullable(),
});
export type AnchorView = z.infer<typeof anchorViewSchema>;
