import { adjudicableKeys } from "./amendment-validation.ts";
import type { Amendment } from "./amendments.ts";
import type { EventType, MetadataField } from "./event-types.ts";
import type { EventView } from "./events.ts";
import type { MetadataValue, Role } from "./roles.ts";

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

/** The adjudication currently in force for a key (following corrections). */
export function activeRuling(
	amendments: Amendment[],
	key: string,
): { id: string; value: MetadataValue } | undefined {
	const superseded = new Set(
		amendments.flatMap((a) =>
			a.kind === "adjudication" && a.supersedes ? [a.supersedes] : [],
		),
	);
	let winner: { id: string; value: MetadataValue; at: number } | undefined;
	for (const a of amendments) {
		if (a.kind !== "adjudication" || superseded.has(a.id)) continue;
		if (!(key in a.patch)) continue;
		if (!winner || a.created_at >= winner.at) {
			winner = { id: a.id, value: a.patch[key], at: a.created_at };
		}
	}
	return winner ? { id: winner.id, value: winner.value } : undefined;
}
