import type { EventType } from "#/shared/event-types.ts";
import { eventTypeSchema } from "#/shared/event-types.ts";
import eventTypesJson from "./event-types.json" with { type: "json" };

/**
 * Ship-time defaults seeded into every couple's Durable Object (handoff §6).
 * The starter seven are versioned JSON so the shape a couple gets is auditable
 * and can evolve without a code migration; custom types added later are
 * first-class and identical in shape (handoff §5).
 */

/** Bumped whenever `event-types.json` changes; recorded per couple at seed. */
export const EVENT_TYPES_VERSION: number = eventTypesJson.version;

/** The starter seven (validated against the shared schema at module load). */
export const STARTER_EVENT_TYPES: EventType[] = eventTypesJson.types.map((t) =>
	eventTypeSchema.parse(t),
);

/**
 * Reserved event type ids that back direct manipulation (handoff §4.1). A "+1"
 * tap is sugar that appends a `counter_adjusted` event; a reset appends a
 * `counter_reset`. Everything is an event, so counters replay purely from the
 * log. These are seeded but hidden from the human-facing type picker.
 */
export const COUNTER_ADJUSTED_TYPE = "counter_adjusted";
export const COUNTER_RESET_TYPE = "counter_reset";

/** True for the reserved counter-manipulation types (excluded from the picker). */
export function isBuiltinType(id: string): boolean {
	return id === COUNTER_ADJUSTED_TYPE || id === COUNTER_RESET_TYPE;
}

export const BUILTIN_EVENT_TYPES: EventType[] = [
	eventTypeSchema.parse({
		id: COUNTER_ADJUSTED_TYPE,
		label: "Counter adjusted",
		icon: "plus-minus",
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {
			counter: {
				kind: "ref",
				ref_kind: "counter",
				label: "Counter",
				required: true,
				set_permission: ["dom", "sub", "switch"],
			},
			delta: {
				kind: "number",
				label: "Delta",
				required: true,
				set_permission: ["dom", "sub", "switch"],
			},
		},
		awaiting: [],
	}),
	eventTypeSchema.parse({
		id: COUNTER_RESET_TYPE,
		label: "Counter reset",
		icon: "rotate-ccw",
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {
			counter: {
				kind: "ref",
				ref_kind: "counter",
				label: "Counter",
				required: true,
				set_permission: ["dom", "sub", "switch"],
			},
		},
		awaiting: [],
	}),
];

/** All event types seeded into a fresh couple: the starter seven plus builtins. */
export const DEFAULT_EVENT_TYPES: EventType[] = [
	...STARTER_EVENT_TYPES,
	...BUILTIN_EVENT_TYPES,
];
