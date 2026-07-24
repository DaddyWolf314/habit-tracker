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

	// The subject-role qualifier (ADR 0003) needs no per-type check: every event
	// may carry a subject regardless of `subject_required` (which governs whether
	// one *must* be given, not whether one may), and the schema already constrains
	// the clause to the role enum. A qualifier that matches no member (e.g. `dom`
	// in a switch/switch couple) is *valid* — the rule is dormant by design, never
	// a creation error, because roles are couple state, not schema.

	// Condition keys must exist on the type, and their values must fit the field.
	for (const [key, value] of Object.entries(rule.condition.metadata)) {
		const field = type.metadata[key];
		if (!field) {
			return fail(`condition references unknown key '${key}' on ${type.id}`);
		}
		const valueError = checkConditionValue(key, field, value);
		if (valueError) return fail(valueError);
	}

	// Effect targets must be known projections, and every routed event key
	// (`duration_from`, `tag_from`, `match_on`, `route_when`) must exist on the
	// triggering type — at runtime an absent key routes `undefined`, which would
	// silently degrade the effect (a countdown that never expires, a match that
	// never pins) instead of failing anywhere visible.
	for (const effect of rule.effects) {
		const error = checkEffectTarget(effect, ctx, type);
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
	type: EventType,
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
			if (!ctx.timers.has(effect.timer)) {
				return `effect targets unknown timer '${effect.timer}'`;
			}
			return (
				checkMatchOn(effect.match_on, type) ??
				checkRoutedKey("tag_from", effect.tag_from, type, ["enum", "ref"]) ??
				checkRoutedKey("duration_from", effect.duration_from, type, ["number"])
			);
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
			return (
				checkMatchOn(effect.match_on, type) ??
				checkRouteWhen(effect.route_when, type)
			);
		case "notify":
			return null; // target is constrained by the schema enum.
	}
}

/**
 * Ensures a routed event key (`tag_from`, `duration_from`) exists on the
 * triggering type and is a field kind the routing can actually use.
 */
function checkRoutedKey(
	label: string,
	key: string | undefined,
	type: EventType,
	kinds: MetadataField["kind"][],
): string | null {
	if (key === undefined) return null;
	const field = type.metadata[key];
	if (!field) {
		return `effect ${label} references unknown key '${key}' on ${type.id}`;
	}
	if (!kinds.includes(field.kind)) {
		return `effect ${label} key '${key}' on ${type.id} must be a ${kinds.join(" or ")} field`;
	}
	return null;
}

/** Ensures every `match_on` ref points at a real key on the triggering type. */
function checkMatchOn(
	matchOn: Record<string, string> | undefined,
	type: EventType,
): string | null {
	if (!matchOn) return null;
	for (const [timerKey, eventKey] of Object.entries(matchOn)) {
		if (!type.metadata[eventKey]) {
			return `effect match_on '${timerKey}' references unknown key '${eventKey}' on ${type.id}`;
		}
	}
	return null;
}

/** Ensures a `route_when` gate reads real keys with fitting values. */
function checkRouteWhen(
	when: Record<string, MetadataValue> | undefined,
	type: EventType,
): string | null {
	if (!when) return null;
	for (const [key, value] of Object.entries(when)) {
		const field = type.metadata[key];
		if (!field) {
			return `effect route_when references unknown key '${key}' on ${type.id}`;
		}
		const valueError = checkConditionValue(key, field, value);
		if (valueError) return valueError;
	}
	return null;
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
