import type { EventType, MetadataField } from "./event-types.ts";
import type { MetadataValue } from "./roles.ts";
import { type Rule, type RuleVersion, ruleFromVersion } from "./rules.ts";

/**
 * Creation-time rule validation (handoff §4.3). A rule is checked against the
 * couple's event-type schema and known projections *when it is created*, so
 * conditioning on a nonexistent key fails loudly at creation rather than
 * silently skipping forever at runtime (which is what an absent key does — and
 * is exactly why a typo'd key would otherwise be invisible). Pure and
 * dependency-free so it runs identically in the client editor and the DO.
 */

/** The projections and types a rule may legally reference. */
export interface RuleValidationContext {
	eventTypes: ReadonlyMap<string, EventType>;
	counters: ReadonlySet<string>;
	anchors: ReadonlySet<string>;
	timers: ReadonlySet<string>;
}

export type RuleValidation = { ok: true } | { ok: false; error: string };

/** Validates a rule's condition and effect targets. First failure wins. */
export function validateRule(
	rule: Rule,
	ctx: RuleValidationContext,
): RuleValidation {
	const type = ctx.eventTypes.get(rule.condition.type);
	if (!type) {
		return fail(`unknown event type: ${rule.condition.type}`);
	}

	// Condition keys must exist on the type, and their values must fit the field.
	for (const [key, value] of Object.entries(rule.condition.metadata)) {
		const field = type.metadata[key];
		if (!field) {
			return fail(`condition references unknown key '${key}' on ${type.id}`);
		}
		const valueError = checkConditionValue(key, field, value);
		if (valueError) return fail(valueError);
	}

	// Effect targets must be known projections.
	for (const effect of rule.effects) {
		const error = checkEffectTarget(effect, ctx);
		if (error) return fail(error);
	}
	return { ok: true };
}

/**
 * Validates a proposed rule *version* on the edit path (ADR 0002, spec #64). An
 * edit appends a new version rather than mutating in place, so it is checked
 * exactly like a create: the version is stamped onto its rule id via
 * {@link ruleFromVersion} and run through the same {@link validateRule}. Editing
 * a rule to condition on an unknown key or target an unknown projection therefore
 * fails with the same clear error a bad create would — the effective-from stamp
 * is validation-irrelevant. Pure, so the client editor and the DO agree exactly.
 */
export function validateRuleVersion(
	id: string,
	version: RuleVersion,
	ctx: RuleValidationContext,
): RuleValidation {
	return validateRule(ruleFromVersion(id, version), ctx);
}

function checkEffectTarget(
	effect: Rule["effects"][number],
	ctx: RuleValidationContext,
): string | null {
	switch (effect.verb) {
		case "increment_counter":
		case "decrement_counter":
		case "reset_counter":
			return ctx.counters.has(effect.counter)
				? null
				: `effect targets unknown counter '${effect.counter}'`;
		case "reset_anchor":
			return ctx.anchors.has(effect.anchor)
				? null
				: `effect targets unknown anchor '${effect.anchor}'`;
		case "open_timer":
			return ctx.timers.has(effect.timer)
				? null
				: `effect targets unknown timer '${effect.timer}'`;
		case "close_timer":
			if (!ctx.timers.has(effect.timer)) {
				return `effect targets unknown timer '${effect.timer}'`;
			}
			if (
				effect.route_duration_to &&
				!ctx.counters.has(effect.route_duration_to)
			) {
				return `effect routes duration to unknown counter '${effect.route_duration_to}'`;
			}
			return null;
		case "notify":
			return null; // target is constrained by the schema enum.
	}
}

/** Ensures a condition's equality value fits the field's kind (catches typos). */
function checkConditionValue(
	key: string,
	field: MetadataField,
	value: MetadataValue,
): string | null {
	switch (field.kind) {
		case "boolean":
			return typeof value === "boolean"
				? null
				: `condition on '${key}' must be a boolean`;
		case "number":
			return typeof value === "number"
				? null
				: `condition on '${key}' must be a number`;
		case "enum":
			return typeof value === "string" && field.options.includes(value)
				? null
				: `condition on '${key}' is not an allowed option`;
		case "ref":
			return typeof value === "string"
				? null
				: `condition on '${key}' must be a reference`;
	}
}

function fail(error: string): RuleValidation {
	return { ok: false, error };
}
