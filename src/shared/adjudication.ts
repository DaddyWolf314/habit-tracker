import { adjudicableKeys } from "./amendment-validation.ts";
import type { Amendment } from "./amendments.ts";
import type { EventType, MetadataField } from "./event-types.ts";
import type { EventView } from "./events.ts";
import { formatMetaValue, type Role } from "./roles.ts";

/**
 * The read model behind the adjudication queue UX (handoff §4.2, §9 surface 3).
 * Pure and dependency-free so the queue, the log row, and any future surface
 * agree on what a role is being asked to decide and which ruling is in force.
 */

/** One awaited decision: the key to rule on and its field definition. */
export interface AwaitedRuling {
	key: string;
	field: MetadataField;
}

/**
 * The rulings a role is being asked to make on an event: its type's `awaiting`
 * keys that are still unset in composite state and that the role is
 * `adjudicated_by` for. Empty unless the event is genuinely pending (never for a
 * resolved or retracted event) — this is exactly the dom's queue.
 */
export function awaitedRulings(
	event: Pick<EventView, "composite_metadata" | "pending" | "retracted">,
	type: EventType,
	role: Role | null,
): AwaitedRuling[] {
	if (!event.pending || event.retracted) return [];
	const rulable = new Set(adjudicableKeys(type, role));
	return type.awaiting
		.filter(
			(key) => rulable.has(key) && event.composite_metadata[key] === undefined,
		)
		.map((key) => ({ key, field: type.metadata[key] }));
}

/**
 * Whether `memberId` may amend this event as its author — the gate for the sub-
 * side note and retraction affordances (handoff §4.2). Both are the author
 * acting on their own event while it is still pending and not yet retracted.
 */
export function isOwnPending(
	event: Pick<EventView, "actor" | "pending" | "retracted">,
	memberId: string | null,
): boolean {
	return (
		memberId !== null &&
		event.actor === memberId &&
		event.pending &&
		!event.retracted
	);
}

/** One amendment rendered for the chain view (handoff §4.6). */
export interface AmendmentLine {
	tone: "ruling" | "note" | "retraction";
	/** What happened, minus the actor/time the row supplies. */
	summary: string;
	/** Any prose attached to the amendment. */
	note?: string;
	actor: string;
	at: number;
}

/**
 * Describes one amendment as a line in the event's chain drill-in (handoff
 * §4.6): the original log → its amendments in order → the rules those unlocked.
 * Pure and label-free — the row prepends who and when.
 */
export function describeAmendment(amendment: Amendment): AmendmentLine {
	const base = { actor: amendment.actor, at: amendment.created_at };
	switch (amendment.kind) {
		case "adjudication": {
			const patched = Object.entries(amendment.patch)
				.map(([key, value]) => `${key}: ${formatMetaValue(value)}`)
				.join(", ");
			const verb = amendment.supersedes ? "revised ruling" : "ruled";
			return {
				tone: "ruling",
				summary: `${verb} — ${patched}`,
				note: amendment.note,
				...base,
			};
		}
		case "note_appended":
			return {
				tone: "note",
				summary: "added a note",
				note: amendment.note,
				...base,
			};
		case "retracted":
			return {
				tone: "retraction",
				summary: "retracted this event",
				note: amendment.note,
				...base,
			};
	}
}
