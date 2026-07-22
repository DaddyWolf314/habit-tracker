import type { EventType } from "./event-types.ts";
import type { MetadataValue } from "./roles.ts";
import type { Effect, Rule, RuleCondition } from "./rules.ts";

/**
 * Plain-language rendering of a rule (#64, user stories 3–5). Turns the dumb
 * condition→effect shape into human sentences so a member never has to read code
 * or JSON to understand the automation that binds them: "when a ritual is logged
 * late → +1 to demerits". Pure and dependency-free — the rules screen renders it,
 * and it is unit-tested here rather than through the UI.
 *
 * Labels come from the couple's event-type schema when available (so an enum
 * value shows its human option and a metadata key its field label); everything
 * else falls back to humanizing the id (underscores → spaces), which reads fine
 * for the counter/anchor/timer ids the pack uses.
 */

/** Underscore-and-lowercase id → readable words: `rituals_completed` → "rituals completed". */
function humanize(id: string): string {
	return id.replace(/_/g, " ").trim();
}

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

/** A single effect as a phrase, e.g. "+2 to demerits" or "notify your partner". */
export function describeEffect(effect: Effect): string {
	switch (effect.verb) {
		case "increment_counter":
			return `+${effect.by} to ${humanize(effect.counter)}`;
		case "decrement_counter":
			return `−${effect.by} from ${humanize(effect.counter)}`;
		case "reset_counter":
			return `reset ${humanize(effect.counter)}`;
		case "reset_anchor":
			return `reset the "${humanize(effect.anchor)}" clock`;
		case "open_timer":
			return `start the ${humanize(effect.timer)} timer`;
		case "close_timer": {
			const stop = `stop the ${humanize(effect.timer)} timer`;
			return effect.route_duration_to
				? `${stop} and add its time to ${humanize(effect.route_duration_to)}`
				: stop;
		}
		case "notify":
			return "notify your partner";
	}
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
