import { z } from "zod";
import type { MetadataValue, Visibility } from "./roles.ts";

/**
 * Journaling pairing and floor satisfaction (ADR 0001, CONTEXT §Journaling) —
 * the second pure seam. Given a `journal_prompt` and a candidate `journal_entry`,
 * it decides two things and nothing else: do they *pair* (same `prompt_id`), and
 * does the entry *satisfy* the assignment (its author-chosen visibility clears the
 * prompt's floor). The DO consults `satisfiesFloor` when a rule-driven close hits
 * a `journal_countdown`, so a below-floor answer never discharges the assignment —
 * the countdown then runs to `expired` unmet. Kept dependency-free (like
 * `timers.ts`) so it is unit-testable in plain Node and the DO and client agree.
 *
 * There is no separate "prompt" entity: a prompt is just a `journal_prompt` event
 * carrying a `prompt_id` (and optional `floor`) in its metadata, and the answer is
 * a `journal_entry` echoing that `prompt_id`. This module reads only those fields.
 */

/** The metadata key both a prompt and its answering entry carry to pair up. */
export const PROMPT_ID_KEY = "prompt_id";

/** The prompt-metadata key holding the answer's minimum visibility, if any. */
export const FLOOR_KEY = "floor";

/**
 * A prompt's visibility floor: the *minimum* level an answer must reach to
 * satisfy the assignment. Only `sealed` and `shared` are floors — `secret` is
 * never one (a secret answer is inert and can discharge nothing; requiring it
 * would just be self-directed journaling). Absent floor ⇒ any non-secret answer
 * satisfies (an assigned prompt implicitly needs at least sealed, since a secret
 * entry fires no close).
 */
export const floorSchema = z.enum(["sealed", "shared"]);
export type Floor = z.infer<typeof floorSchema>;

/**
 * The credit ordering the floor compares against: `secret < sealed < shared`.
 * This is the one place the gradient is ranked; `visibilitySchema` in `roles.ts`
 * only names the levels.
 */
const RANK: Record<Visibility, number> = { secret: 0, sealed: 1, shared: 2 };

/** The minimal shape this module reads off an event — just its metadata. */
type WithMetadata = { metadata: Record<string, MetadataValue> };

/** The `prompt_id` an event carries, or `undefined` if it carries none. */
export function promptRef(event: WithMetadata): string | undefined {
	const ref = event.metadata[PROMPT_ID_KEY];
	return typeof ref === "string" ? ref : undefined;
}

/**
 * The floor a prompt sets, or `undefined` for a floorless prompt. A malformed or
 * `secret` value is treated as no floor — `secret` is never a valid floor.
 */
export function promptFloor(prompt: WithMetadata): Floor | undefined {
	const parsed = floorSchema.safeParse(prompt.metadata[FLOOR_KEY]);
	return parsed.success ? parsed.data : undefined;
}

/**
 * A self-directed entry carries no `prompt_id` — it answers nothing and is never
 * gated by any floor. (Its own visibility is still the author's free choice.)
 */
export function isSelfDirected(entry: WithMetadata): boolean {
	return promptRef(entry) === undefined;
}

/**
 * Whether an entry answers a specific prompt: both carry the same non-empty
 * `prompt_id`. This is the same ref-pairing the `session_started`/`session_ended`
 * pair uses — no completeness logic, one entry per prompt.
 */
export function pairsWith(entry: WithMetadata, prompt: WithMetadata): boolean {
	const entryRef = promptRef(entry);
	const promptId = promptRef(prompt);
	return entryRef !== undefined && entryRef === promptId;
}

/**
 * Whether an answer's chosen visibility clears a floor (ADR 0001). `shared`
 * clears every floor; `sealed` clears a `sealed` floor but not `shared`; `secret`
 * clears nothing. A `null`/absent floor is cleared by any non-secret level — and
 * `secret` is inert, so it never even reaches this check via the close path.
 */
export function satisfiesFloor(
	visibility: Visibility,
	floor: Floor | null | undefined,
): boolean {
	if (floor === null || floor === undefined) return visibility !== "secret";
	return RANK[visibility] >= RANK[floor];
}

/**
 * Whether an entry satisfies a prompt's assignment: it must pair with the prompt
 * *and* its visibility must clear the prompt's floor. A paired-but-below-floor
 * answer returns `false` — it does not close the countdown, which then expires
 * unmet, and the dom is never told the below-floor entry exists.
 */
export function satisfiesAssignment(
	entry: WithMetadata & { visibility: Visibility },
	prompt: WithMetadata,
): boolean {
	return (
		pairsWith(entry, prompt) &&
		satisfiesFloor(entry.visibility, promptFloor(prompt))
	);
}
