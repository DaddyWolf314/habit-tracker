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

/**
 * The `prompt_id` an event carries, or `undefined` if it carries none. An empty
 * string is "none" too — a ref that names nothing must not pair with anything
 * (an empty-ref entry would otherwise "answer" an empty-ref prompt).
 */
export function promptRef(event: WithMetadata): string | undefined {
	const ref = event.metadata[PROMPT_ID_KEY];
	return typeof ref === "string" && ref !== "" ? ref : undefined;
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
 * One outstanding prompt as the answer picker sees it (#102): the minted
 * `prompt_id` to echo, the question to display, and enough countdown state to
 * label urgency. `expired` marks a recently-expired-unmet prompt — a late answer
 * is still the sub's right to log (and still pairs for history); it just no
 * longer discharges the countdown.
 */
export const openPromptViewSchema = z.object({
	prompt_id: z.string(),
	/** The prompt's `note` — the question itself. */
	question: z.string().nullable(),
	floor: floorSchema.nullable(),
	deadline_at: z.number().int().nullable(),
	paused: z.boolean(),
	expired: z.boolean(),
});
export type OpenPromptView = z.infer<typeof openPromptViewSchema>;

/** The countdown state `openPromptViews` reads — a slice of the DO's TimerState. */
export interface PromptCountdown {
	match: Record<string, MetadataValue>;
	/** The opening `journal_prompt`'s event id; absent on pre-#102 timers. */
	opened_by?: string;
	deadline_at?: number;
	paused_at?: number;
	expired: boolean;
}

/** The prompt-event slice `openPromptViews` joins against. */
export interface PromptEvent extends WithMetadata {
	id: string;
	subject?: string | null;
	note?: string | null;
}

/**
 * Composes the open-prompt views for one member: each `journal_countdown` joined
 * back to its `journal_prompt` (by `opened_by`, falling back to the `prompt_id`
 * ref for pre-#102 timers), kept only when that prompt is assigned to
 * `subjectId`. A countdown whose prompt can't be resolved is dropped — the
 * picker can't pose a question it doesn't have.
 */
export function openPromptViews(
	countdowns: PromptCountdown[],
	prompts: PromptEvent[],
	subjectId: string,
): OpenPromptView[] {
	const byId = new Map(prompts.map((p) => [p.id, p]));
	const byRef = new Map<string, PromptEvent>();
	for (const p of prompts) {
		const ref = promptRef(p);
		if (ref !== undefined && !byRef.has(ref)) byRef.set(ref, p);
	}
	const views: OpenPromptView[] = [];
	for (const cd of countdowns) {
		const ref = cd.match[PROMPT_ID_KEY];
		if (typeof ref !== "string" || ref === "") continue;
		const prompt =
			(cd.opened_by !== undefined ? byId.get(cd.opened_by) : undefined) ??
			byRef.get(ref);
		if (!prompt || prompt.subject !== subjectId) continue;
		views.push({
			prompt_id: ref,
			question: prompt.note ?? null,
			floor: promptFloor(prompt) ?? null,
			deadline_at: cd.deadline_at ?? null,
			paused: cd.paused_at !== undefined,
			expired: cd.expired,
		});
	}
	return views;
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
