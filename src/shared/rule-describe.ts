import {
	NO_ACTIVE_TIMERS,
	NO_COUNTER_VALUES,
	resolveEffect,
} from "./engine.ts";
import type { EventType, MetadataField } from "./event-types.ts";
import { optionLabel } from "./event-types.ts";
import type { MetadataValue } from "./roles.ts";
import {
	ambientClauses,
	type ComparisonClause,
	counterClauses,
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
 * The couple's voice for each comparison operator (ADR 0011), in the two shapes
 * the surfaces need: `sentence` completes "Mood is …" once the value is known
 * ("2 or less"), and `operator` names the op alone, for the editor's select where
 * the value sits in the next control ("is at most" + "2").
 *
 * One table because they are the same vocabulary in two grammars — a rule read on
 * the rules screen and the same rule being authored have to sound like each
 * other, and two lists drifted the moment they existed. The engine's near-miss
 * prose is deliberately *not* here: it stays symbolic ("needs <= 2") because it
 * is read beside a rule id in the trace, not in a sentence.
 */
export const COMPARISON_COPY: Record<
	ComparisonClause["op"],
	{ operator: string; sentence: (value: number) => string }
> = {
	lt: { operator: "is under", sentence: (v) => `under ${v}` },
	lte: { operator: "is at most", sentence: (v) => `${v} or less` },
	gt: { operator: "is over", sentence: (v) => `over ${v}` },
	gte: { operator: "is at least", sentence: (v) => `${v} or more` },
};

function comparisonText(clause: ComparisonClause): string {
	return COMPARISON_COPY[clause.op].sentence(clause.value);
}

/**
 * The ambient-state predicate as a trailing clause (ADR 0011) — "while a denial
 * period is running". Trailing rather than folded in with the metadata, because
 * it is a fact about the moment rather than about the event, and the sentence
 * should not blur the two.
 */
function ambientText(condition: RuleCondition): string {
	const clauses = [
		...ambientClauses(condition).map(([timer, wanted]) =>
			wanted
				? `a ${humanize(timer)} is running`
				: `no ${humanize(timer)} is running`,
		),
		// The counter-value predicate joins the same trailing clause (ADR 0015) rather than
		// getting one of its own: it is a fact about the moment, exactly as a running
		// timer is, and a sentence that said "while a denial period is running, while
		// demerits are 10 or more" would invent a distinction the language does not
		// make. "are" rather than "is" because a counter is a tally, and the ADR's own
		// wording for this clause is "while demerits are 10 or more".
		...counterClauses(condition).map(
			([counter, clause]) =>
				`${humanize(counter)} are ${comparisonText(clause)}`,
		),
	];
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
 *
 * A **routed** value is the one thing this cannot borrow the shared phrase for
 * (ADR 0015, ADR 0017), and deliberately so: `resolveEffect` against an empty
 * context resolves a `by_from` or a `counter_from` to a *skip*, which is the
 * truth about that context and a lie about the rule. A description has no event,
 * so it names the key instead of the value — the same move the timer-close line
 * below makes when it states a routing the shared phrase has no room for.
 */
/**
 * How a delta effect names the counter it moves: the counter itself, or — when
 * the target is routed (ADR 0017) — the key it is read from, phrased as a key
 * rather than dressed up as a counter name. "subtract Price from the counter
 * named by Currency" is longer than "subtract Price from service points" and is
 * the only honest reading: which counter moves depends on the event, and a
 * description that names one would be describing a single redemption rather than
 * the rule.
 */
function routedCounterLabel(
	counter: string | undefined,
	counterFrom: string | undefined,
	type?: EventType,
): string {
	if (counterFrom === undefined) return humanize(counter ?? "");
	const label = type?.metadata[counterFrom]?.label ?? humanize(counterFrom);
	return `the counter named by ${label}`;
}

export function describeEffect(effect: Effect, type?: EventType): string {
	if (
		(effect.verb === "increment_counter" ||
			effect.verb === "decrement_counter") &&
		(effect.by_from !== undefined || effect.counter_from !== undefined)
	) {
		const amount =
			effect.by_from === undefined
				? String(effect.by)
				: (type?.metadata[effect.by_from]?.label ?? humanize(effect.by_from));
		const target = routedCounterLabel(
			effect.counter,
			effect.counter_from,
			type,
		);
		const verb = effect.verb === "increment_counter" ? "add" : "subtract";
		const preposition = effect.verb === "increment_counter" ? "to" : "from";
		return `${verb} ${amount} ${preposition} ${target}`;
	}
	const op = resolveEffect(effect, {
		type: "",
		metadata: {},
		occurred_at: 0,
		active_timers: NO_ACTIVE_TIMERS,
		counter_values: NO_COUNTER_VALUES,
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
		effects: rule.effects.map((effect) => describeEffect(effect, type)),
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
