import type { CounterDefinition } from "#/shared/counters.ts";
import { counterDefinitionSchema } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import { eventTypeSchema } from "#/shared/event-types.ts";
import type { Rule } from "#/shared/rules.ts";
import { ruleSchema } from "#/shared/rules.ts";
import countersJson from "./counters.json" with { type: "json" };
import eventTypesJson from "./event-types.json" with { type: "json" };
import rulesJson from "./rules.json" with { type: "json" };

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

/**
 * The `counter_` prefix is a reserved namespace: the composer hides any type id
 * that starts with it, so custom types may not use it — otherwise they would be
 * created but never appear in the picker (unloggable). Broader than
 * {@link isBuiltinType}, which matches only the two real builtins.
 */
export function isReservedTypeId(id: string): boolean {
	return id.startsWith("counter_");
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

/**
 * The default projections & rule pack (handoff §7) — the installable template
 * that turns the starter seven into a working dynamic. Versioned as one unit so
 * a couple's seeded pack is auditable and can evolve without a code migration;
 * the guard version lives on the rule pack (bump it whenever either the rules or
 * the default counters change). Every rule condition, counter, anchor, and timer
 * here derives from only the starter seven — the acceptance test for §7.
 */
export const RULE_PACK_VERSION: number = rulesJson.version;

/** The R1–R18 default rules (validated against the shared schema at load). */
export const DEFAULT_RULES: Rule[] = rulesJson.rules.map((r) =>
	ruleSchema.parse(r),
);

/** The default counter projections the pack drives (§7 Projections). */
export const DEFAULT_COUNTERS: CounterDefinition[] = countersJson.counters.map(
	(c) => counterDefinitionSchema.parse(c),
);

/**
 * The default elapsed-since anchors (§7). Anchors are trivial state (a single
 * reset timestamp); a rule effect resets them. Named here so rule validation and
 * the trace have a known projection set to check against; their live projection
 * (the "days since" display) lands with timers in Phase 4.
 */
export const DEFAULT_ANCHORS: readonly string[] = [
	"since_last_infraction",
	"since_last_orgasm",
	"since_last_check_in",
	// Dom-side visibility (ADR 0003): reset by R21 on a dom-subject orgasm. The
	// naming convention is glossary law — an unqualified name means the sub's,
	// the dom_ marker means the dom's.
	"since_dom_last_orgasm",
];

/**
 * Display labels for the pack anchors (#76, ADR 0003) — pack-owned, like
 * counter names in `counters.json`, so they ship with a pack bump rather than
 * living in any one screen. Follows the glossary naming convention (an
 * unqualified name means the sub's; the dom_ marker the dom's).
 */
const PACK_ANCHOR_LABELS: Record<string, string> = {
	since_last_infraction: "since last infraction",
	since_last_orgasm: "since sub's last orgasm",
	since_last_check_in: "since last check-in",
	since_dom_last_orgasm: "since dom's last orgasm",
};

/**
 * The display label for an anchor id — the one phrasing path every surface
 * (anchors panel, adjudication evidence, the rule editor's clock picker)
 * shares. Unknown/custom anchors fall back to humanizing the id.
 */
export function anchorLabel(id: string): string {
	return PACK_ANCHOR_LABELS[id] ?? id.replace(/_/g, " ");
}

/** The default timers the pack opens/closes (§7). The state machine is Phase 4. */
export const DEFAULT_TIMERS: readonly string[] = [
	"task_countdown",
	"denial_period",
	"session_stopwatch",
	"journal_countdown",
];

/**
 * The journal-prompt deadline countdown (ADR 0001). Unlike the other countdowns
 * (dom-assigned via `assignCountdown`), this one is *rule-opened*: R19 opens it on
 * a `journal_prompt` and R20's answering `journal_entry` closes it by `prompt_id`
 * match. The DO opens it as a `countdown` (not a stopwatch) so it carries a real
 * deadline and inherits pause/extend/expire for free.
 */
export const JOURNAL_COUNTDOWN_TIMER = "journal_countdown";

/**
 * Default time a sub has to answer an assigned prompt before the countdown
 * expires unmet. A first-cut policy default (the rule carries no duration, and
 * `open_timer` cannot route one without touching the pure engine); the dom can
 * still pause or extend it via the existing countdown commands.
 */
export const DEFAULT_JOURNAL_DEADLINE_MS: number = 24 * 60 * 60 * 1000;
