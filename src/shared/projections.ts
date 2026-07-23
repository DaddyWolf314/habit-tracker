import {
	COUNTER_ADJUSTED_TYPE,
	COUNTER_RESET_TYPE,
} from "#/templates/index.ts";
import type { Amendment } from "./amendments.ts";
import { awaitingKeysFor, type EventType } from "./event-types.ts";
import type { Event, EventView } from "./events.ts";
import type { MetadataValue, Role } from "./roles.ts";

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
 * *in force for its subject* (ADR 0003 — a qualified entry gates only when the
 * subject resolves to its role) is unset in composite state. This single
 * derivation is the adjudication-queue mechanism; a retracted event is never
 * pending. `subjectRole` is the event's resolved subject role — callers resolve
 * it via `resolveSubjectRole`, exactly as the rule engine's context does.
 */
export function isPending(
	eventType: Pick<EventType, "awaiting">,
	composite: MetadataBag,
	retracted = false,
	subjectRole?: Role,
): boolean {
	if (retracted) return false;
	return awaitingKeysFor(eventType.awaiting, subjectRole).some(
		(key) => composite[key] === undefined,
	);
}

/**
 * The composite read view of an event (handoff §4.2, §4.6): the raw event, its
 * amendments, and the derived `composite_metadata`, `pending`, and `retracted`
 * status — all folded on read, never stored. The single place the server, the
 * DO, and the client agree on what an amended event *currently means*. A missing
 * `eventType` (an event of a since-removed type) touches nothing, so it is never
 * pending. `subjectRole` is the event's resolved subject role (ADR 0003),
 * resolved by the caller — qualified awaiting entries gate pending only when it
 * matches.
 */
export function deriveEventView(
	event: Event,
	amendments: Amendment[] = [],
	eventType?: Pick<EventType, "awaiting">,
	subjectRole?: Role,
): EventView {
	const composite = compositeMetadata(event, amendments);
	const retracted = isRetracted(amendments);
	return {
		...event,
		amendments,
		composite_metadata: composite,
		pending: eventType
			? isPending(eventType, composite, retracted, subjectRole)
			: false,
		retracted,
	};
}
