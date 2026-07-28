import { z } from "zod";
import type { EventView } from "./events.ts";

/**
 * Conversation flags (ADR 0007, CONTEXT §Conversation flag) — the read model
 * behind R18, `check_in AND flag=wants_conversation → notify partner`.
 *
 * The rule has shipped since the pack existed and its whole effect was a trace
 * row, so there was no record to query and Today had nothing to render. The flag
 * is **derived from the log**: a `check_in` carrying `flag=wants_conversation` is
 * open until the *other* member attaches a `response` amendment to it. Nothing new
 * is stored, so the open state cannot drift out of step with the log — the same
 * shape `pending` already has, and the reason this is a fold rather than a table.
 *
 * Pure and dependency-light (like `adjudication.ts`) so the DO and the client
 * agree on what "still open" means and it is unit-testable in plain Node.
 */

/** The `check_in` metadata key R18 conditions on. */
export const CONVERSATION_FLAG_KEY = "flag";

/** Its one value — the sub (or dom) saying they want to talk. */
export const WANTS_CONVERSATION = "wants_conversation";

/** The event type that carries the flag, matching R18's condition. */
export const CONVERSATION_FLAG_TYPE = "check_in";

/**
 * Whether an event is an *ask* to talk: a `check_in` whose composite `flag` reads
 * `wants_conversation`. This mirrors R18's condition rather than consulting the
 * couple's rule set — the flag is derived from the **log**, so disabling or
 * editing R18 changes what gets *notified*, never what was recorded as asked.
 *
 * Composite rather than raw metadata, so the event as it now stands is what
 * counts; `flag` carries no `adjudicated_by` in the pack, so today the two agree.
 */
export function raisesConversationFlag(
	event: Pick<EventView, "type" | "composite_metadata">,
): boolean {
	return (
		event.type === CONVERSATION_FLAG_TYPE &&
		event.composite_metadata[CONVERSATION_FLAG_KEY] === WANTS_CONVERSATION
	);
}

/**
 * Whether the partner has answered: any `response` amendment by someone other
 * than the author. A response *is* the resolution (ADR 0007 — "the dom replying
 * **is** the resolution"), so the first one closes the flag and later ones are
 * just more conversation in the log.
 *
 * The actor check is belt-and-braces — `validateResponse` already refuses a
 * response on your own event — but the fold must not depend on the write path to
 * stay correct about whose reply closes whose ask.
 */
export function isAnswered(
	event: Pick<EventView, "actor" | "amendments">,
): boolean {
	return event.amendments.some(
		(a) => a.kind === "response" && a.actor !== event.actor,
	);
}

/**
 * One open conversation flag, as Today receives it. Carries the check-in itself —
 * who asked, when, the prose and the mood — because the answer is a *response*
 * with prose, so the surface has to show what is being replied to. `event_id` is
 * the amendment target.
 */
export const conversationFlagViewSchema = z.object({
	event_id: z.string(),
	/** The member who asked to talk; the viewer compares it to decide the affordance. */
	actor: z.string(),
	occurred_at: z.number().int(),
	/** The check-in's prose ("How are you doing?"), or null if they wrote none. */
	note: z.string().nullable(),
	/** The check-in's 1–5 mood, or null if it is missing or not a number. */
	mood: z.number().nullable(),
});
export type ConversationFlagView = z.infer<typeof conversationFlagViewSchema>;

/**
 * The flags still waiting on a reply, **oldest first** — an ask that has gone
 * unanswered longest is the one most worth seeing, and this list never drains on
 * its own, so recency is the wrong order for it.
 *
 * A retracted check-in raises nothing: withdrawing the event withdraws the ask
 * with it, and a retraction is terminal so no response can ever land on it.
 *
 * Note what is *absent*: any notion of expiry. The app cannot observe a
 * conversation happening, so a flag that lapsed on a timer would be the app
 * deciding, quietly, that someone no longer needs to talk. Only a person ends one.
 */
export function openConversationFlags(
	events: EventView[],
): ConversationFlagView[] {
	return events
		.filter((e) => raisesConversationFlag(e) && !e.retracted && !isAnswered(e))
		.map((e) => ({
			event_id: e.id,
			actor: e.actor,
			occurred_at: e.occurred_at,
			note: e.note ?? null,
			mood:
				typeof e.composite_metadata.mood === "number"
					? e.composite_metadata.mood
					: null,
		}))
		.sort((a, b) => a.occurred_at - b.occurred_at);
}
