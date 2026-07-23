import { resolveEffect } from "./engine.ts";
import type { EventType } from "./event-types.ts";
import type { MetadataValue } from "./roles.ts";
import type { Effect, Rule, RuleCondition } from "./rules.ts";
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

function valueText(value: MetadataValue): string {
	if (typeof value === "boolean") return value ? "yes" : "no";
	return humanize(String(value));
}

/** "when a ritual is logged" plus each metadata equality, e.g. "and late is yes". */
export function describeCondition(
	condition: RuleCondition,
	type?: EventType,
): string {
	const typeLabel = type?.label ?? humanize(condition.type);
	const clauses = Object.entries(condition.metadata).map(([key, value]) => {
		const fieldLabel = type?.metadata[key]?.label ?? humanize(key);
		return `${fieldLabel} is ${valueText(value)}`;
	});
	const when = `when ${typeLabel} is logged`;
	return clauses.length ? `${when} and ${clauses.join(" and ")}` : when;
}

/**
 * A single effect as a phrase, e.g. "+2 demerits" or "notify partner" — the
 * shared {@link summarizeEffectOp} phrase, so it reads identically here and on
 * the confirm/trace surfaces. The effect is resolved against an empty event
 * context (description needs no event); a timer close's duration routing, which
 * only the rules screen states up front, is appended to the shared phrase.
 */
export function describeEffect(effect: Effect): string {
	const op = resolveEffect(effect, { type: "", metadata: {}, occurred_at: 0 });
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
