import { NO_ACTIVE_TIMERS, resolveEffect } from "./engine.ts";
import type { EventType, MetadataField } from "./event-types.ts";
import { optionLabel } from "./event-types.ts";
import type { MetadataValue } from "./roles.ts";
import {
	ambientClauses,
	type ComparisonClause,
	type Effect,
	isComparisonClause,
	type Rule,
	type RuleCondition,
} from "./rules.ts";
import { humanize, summarizeEffectOp } from "./trace.ts";

/**
 * Plain-language rendering of a rule (#64, user stories 3–5). Turns the dumb
 * condition→effect shape into human sentences so a member never has to read code
 * or JSON to understand the automation that binds them: "when a ritual is logged
 * late → +1 demerits". Pure — the rules screen renders it, and it is unit-tested
 * here rather than through the UI.
 *
 * Effect phrasing routes through {@link summarizeEffectOp} — the same shared
 * vocabulary the confirm sheet ("what will fire") and the trace chain view ("what
 * fired") read — so the rules screen never describes an effect differently than
 * the surfaces that show it firing (CONTEXT.md, Trace).
 *
 * Condition labels come from the couple's event-type schema when available (so an
 * enum value shows its human option and a metadata key its field label);
 * everything else falls back to humanizing the id (underscores → spaces), which
 * reads fine for the counter/anchor/timer ids the pack uses.
 */

function valueText(
	field: MetadataField | undefined,
	value: MetadataValue,
): string {
	if (typeof value === "boolean") return value ? "yes" : "no";
	// The docstring above has promised "an enum value shows its human option"
	// since #64; until the pack carried per-option copy (#155) a de-slug was the
	// most this could do.
	if (field?.kind === "enum" && typeof value === "string") {
		return optionLabel(field, value);
	}
	return humanize(String(value));
}

/**
 * A comparison clause in the couple's voice (ADR 0011) — "2 or less", not
 * "<= 2". The engine's near-miss prose stays symbolic because it is read beside
 * a rule id in the trace; this is read in a sentence on the rules screen.
 */
function comparisonText(clause: ComparisonClause): string {
	switch (clause.op) {
		case "lt":
			return `under ${clause.value}`;
		case "lte":
			return `${clause.value} or less`;
		case "gt":
			return `over ${clause.value}`;
		case "gte":
			return `${clause.value} or more`;
	}
}

/**
 * The ambient-state predicate as a trailing clause (ADR 0011) — "while a denial
 * period is running". Trailing rather than folded in with the metadata, because
 * it is a fact about the moment rather than about the event, and the sentence
 * should not blur the two.
 */
function ambientText(condition: RuleCondition): string {
	const clauses = ambientClauses(condition).map(([timer, wanted]) =>
		wanted
			? `a ${humanize(timer)} is running`
			: `no ${humanize(timer)} is running`,
	);
	return clauses.length ? `, while ${clauses.join(" and ")}` : "";
}

/**
 * "when a ritual is logged" plus the subject-role qualifier ("about the sub",
 * ADR 0003), each metadata constraint ("and late is yes", "and mood is 2 or
 * less"), and the ambient-state clause ("while a denial period is running",
 * ADR 0011). One renderer: the rules screen, the confirm sheet, and the chain
 * view all read the clause through here, so "what will fire" and "what fired"
 * phrase it identically.
 */
export function describeCondition(
	condition: RuleCondition,
	type?: EventType,
): string {
	const typeLabel = type?.label ?? humanize(condition.type);
	const clauses = Object.entries(condition.metadata).map(([key, value]) => {
		const field = type?.metadata[key];
		const fieldLabel = field?.label ?? humanize(key);
		const text = isComparisonClause(value)
			? comparisonText(value)
			: valueText(field, value);
		return `${fieldLabel} is ${text}`;
	});
	const about = condition.subject_role
		? ` about the ${condition.subject_role}`
		: "";
	const when = `when ${typeLabel} is logged${about}`;
	const said = clauses.length ? `${when} and ${clauses.join(" and ")}` : when;
	return `${said}${ambientText(condition)}`;
}

/**
 * A single effect as a phrase, e.g. "+2 demerits" or "notify partner" — the
 * shared {@link summarizeEffectOp} phrase, so it reads identically here and on
 * the confirm/trace surfaces. The effect is resolved against an empty event
 * context (description needs no event); a timer close's duration routing, which
 * only the rules screen states up front, is appended to the shared phrase.
 */
export function describeEffect(effect: Effect): string {
	const op = resolveEffect(effect, {
		type: "",
		metadata: {},
		occurred_at: 0,
		active_timers: NO_ACTIVE_TIMERS,
	});
	const phrase = summarizeEffectOp(op);
	return effect.verb === "close_timer" && effect.route_duration_to
		? `${phrase} and add its time to ${humanize(effect.route_duration_to)}`
		: phrase;
}

/** A rule as a condition sentence plus its list of effect phrases. */
export function describeRule(
	rule: Rule,
	type?: EventType,
): { when: string; effects: string[] } {
	return {
		when: describeCondition(rule.condition, type),
		effects: rule.effects.map(describeEffect),
	};
}

/**
 * Whether a rule's effects reach outside the structured picker's everyday set
 * (counter/anchor/notify). Timer wiring (`open_timer`/`close_timer`) is shown
 * read-only rather than handed to a fiddly editor (#64 scope line), so the rules
 * screen uses this to mark a rule "advanced — view only".
 */
export function isPickerEditable(rule: Rule): boolean {
	return rule.effects.every(
		(effect) => effect.verb !== "open_timer" && effect.verb !== "close_timer",
	);
}
