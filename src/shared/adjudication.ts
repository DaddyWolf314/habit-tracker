import { adjudicableKeys } from "./amendment-validation.ts";
import type { Amendment } from "./amendments.ts";
import {
	awaitingKeysFor,
	type EventType,
	type MetadataField,
} from "./event-types.ts";
import type { EventView } from "./events.ts";
import { formatMetaValue, type Role, subjectRoleOf } from "./roles.ts";

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
 * keys *in force for the event's subject* (ADR 0003 — a subject-qualified entry
 * asks for no ruling when the subject doesn't match) that are still unset in
 * composite state and that the role is `adjudicated_by` for. Empty unless the
 * event is genuinely pending (never for a resolved or retracted event) — this
 * is exactly the dom's queue. `subjectRole` is the event's resolved subject
 * role, via the same `resolveSubjectRole` seam the engine context uses.
 */
export function awaitedRulings(
	event: Pick<EventView, "composite_metadata" | "pending" | "retracted">,
	type: EventType,
	role: Role | null,
	subjectRole?: Role,
): AwaitedRuling[] {
	if (!event.pending || event.retracted) return [];
	const rulable = new Set(adjudicableKeys(type, role));
	return awaitingKeysFor(type.awaiting, subjectRole)
		.filter(
			(key) => rulable.has(key) && event.composite_metadata[key] === undefined,
		)
		.map((key) => ({ key, field: type.metadata[key] }));
}

/** One queued event: what it is, its type, and the keys this role must rule. */
export interface QueuedEvent {
	event: EventView;
	type: EventType;
	rulings: AwaitedRuling[];
}

/**
 * The adjudication queue for one role — every event with a key they must rule
 * (handoff §8). The queue is "a lens over the log, not a holding pen"
 * (CONTEXT §Adjudication queue), so it is a fold rather than a stored list.
 *
 * One fold, because two would drift: the dom's queue panel and the Today entry's
 * count are the same question asked twice, and a change to what counts as
 * awaiting a ruling has to reach both. Subject-qualified `awaiting` entries
 * (ADR 0003) resolve through the same seam the DO uses.
 */
export function queueFor({
	events,
	types,
	members,
	role,
}: {
	events: EventView[];
	types: EventType[];
	members: Array<{ member_id: string; role: Role | null }>;
	role: Role | null;
}): QueuedEvent[] {
	if (role === null) return [];
	const byId = new Map(types.map((t) => [t.id, t]));
	return events.flatMap((event) => {
		const type = byId.get(event.type);
		if (!type) return [];
		const subjectRole = subjectRoleOf(event.subject, members);
		const rulings = awaitedRulings(event, type, role, subjectRole);
		return rulings.length > 0 ? [{ event, type, rulings }] : [];
	});
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

/**
 * Whether `memberId` may respond to this event — the gate for the respond
 * affordance wherever a partner's entry is rendered (#183).
 *
 * Deliberately a *mirror of the server's* check rather than a list of types you
 * may respond to. `validateResponse` (`amendment-validation.ts`) already answers
 * "may this response be written", and it answers it from authorship and
 * visibility alone; a client-side type allowlist would be a second source of
 * truth about the same question, and the two would drift the moment the pack
 * grows a type. So this asks exactly what the server asks:
 *  - not your own entry (a response to yourself is what `note_appended` is for);
 *  - not `secret` (the read model omits those from the partner's log entirely,
 *    so this is belt-and-braces — but stating it keeps the mirror honest);
 *  - not retracted, because `validateAmendment` refuses *every* amendment on a
 *    retracted event before it reaches `validateResponse`. Offering a button
 *    that can only fail is worse than offering none.
 */
export function canRespondTo(
	event: Pick<EventView, "actor" | "visibility" | "retracted">,
	memberId: string | null,
): boolean {
	return (
		memberId !== null &&
		event.actor !== memberId &&
		event.visibility !== "secret" &&
		!event.retracted
	);
}

/** One amendment rendered for the chain view (handoff §4.6). */
export interface AmendmentLine {
	tone: "ruling" | "note" | "retraction" | "response";
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
		case "response":
			return {
				tone: "response",
				summary: "responded to this entry",
				note: amendment.note,
				...base,
			};
	}
}
