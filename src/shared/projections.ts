import {
	COUNTER_ADJUSTED_TYPE,
	COUNTER_RESET_TYPE,
} from "#/templates/index.ts";
import type { Amendment } from "./amendments.ts";
import type { EventType } from "./event-types.ts";
import type { Event } from "./events.ts";
import type { MetadataValue } from "./roles.ts";

/**
 * Pure projection logic — the single source of truth for how the event log
 * folds into derived state (handoff §4.4, §4.6). Kept free of any storage or
 * runtime dependency so the Durable Object and the client agree exactly, and so
 * it is unit-testable in plain Node. The DO applies these incrementally on
 * append *and* can replay them from scratch to prove the cache is honest.
 */

type MetadataBag = Record<string, MetadataValue>;

/** A counter event reduced to the fields the fold cares about. */
export interface CounterEventInput {
	type: string;
	logged_at: number;
	id: string;
	metadata: MetadataBag;
}

/** Applies one event to a running counter value. Unknown types are inert. */
export function applyCounterEvent(
	value: number,
	event: CounterEventInput,
): number {
	switch (event.type) {
		case COUNTER_ADJUSTED_TYPE: {
			const delta = event.metadata.delta;
			return value + (typeof delta === "number" ? delta : 0);
		}
		case COUNTER_RESET_TYPE:
			return 0;
		default:
			return value;
	}
}

/** True if an event targets the given counter (a `counter` ref in metadata). */
export function targetsCounter(
	event: CounterEventInput,
	counterId: string,
): boolean {
	return (
		(event.type === COUNTER_ADJUSTED_TYPE ||
			event.type === COUNTER_RESET_TYPE) &&
		event.metadata.counter === counterId
	);
}

/**
 * Rebuilds a counter's value from scratch by replaying its events in append
 * order (`logged_at`, then id as a stable tie-break — ULIDs are monotonic).
 * This must reproduce the incrementally-maintained cache exactly.
 */
export function replayCounterValue(
	counterId: string,
	events: CounterEventInput[],
): number {
	return events
		.filter((e) => targetsCounter(e, counterId))
		.sort(
			(a, b) =>
				a.logged_at - b.logged_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		)
		.reduce(applyCounterEvent, 0);
}

/**
 * Composite metadata (handoff §4.2): the original event metadata overlaid by
 * its amendments in `created_at` order, latest non-superseded ruling winning per
 * key. Derived, never stored. Phase 2 produces no amendments, so this is just
 * the original — but the fold is here so the log UI is correct from day one.
 */
export function compositeMetadata(
	event: Pick<Event, "metadata">,
	amendments: Amendment[] = [],
): MetadataBag {
	const superseded = new Set(
		amendments
			.filter((a) => a.kind === "adjudication" && a.supersedes)
			.map(
				(a) =>
					(a as Extract<Amendment, { kind: "adjudication" }>)
						.supersedes as string,
			),
	);
	const composite: MetadataBag = { ...event.metadata };
	for (const amendment of [...amendments].sort(
		(a, b) => a.created_at - b.created_at,
	)) {
		if (amendment.kind !== "adjudication" || superseded.has(amendment.id))
			continue;
		for (const [key, val] of Object.entries(amendment.patch))
			composite[key] = val;
	}
	return composite;
}

/**
 * Whether an event has been retracted (handoff §4.2): it carries a `retracted`
 * amendment. There is no deletion — retraction is a visible, terminal marker
 * derived from the amendment log, and it drops the event from the queue via
 * `isPending` below.
 */
export function isRetracted(amendments: Amendment[] = []): boolean {
	return amendments.some((a) => a.kind === "retracted");
}

/**
 * Whether an event is *pending* (handoff §5): any of its type's `awaiting` keys
 * is unset in composite state. This single derivation is the adjudication-queue
 * mechanism; a retracted event is never pending.
 */
export function isPending(
	eventType: Pick<EventType, "awaiting">,
	composite: MetadataBag,
	retracted = false,
): boolean {
	if (retracted) return false;
	return eventType.awaiting.some((key) => composite[key] === undefined);
}
