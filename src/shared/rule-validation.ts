import type { EventType, MetadataField } from "./event-types.ts";
import type { MetadataValue } from "./roles.ts";
import {
	ambientClauses,
	counterClauses,
	isComparisonClause,
	type Rule,
	type RuleVersion,
	ruleFromVersion,
} from "./rules.ts";

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
		const valueError = isComparisonClause(value)
			? checkComparison(key, field)
			: checkConditionValue(key, field, value);
		if (valueError) return fail(valueError);
	}

	// The ambient-state predicate (ADR 0011) names timer *definitions*, checked
	// against the same set an effect's timer target is. A typo'd definition would
	// otherwise read as "never active" and silently hold the rule shut for ever —
	// the same invisible failure an unknown metadata key would cause.
	for (const [timer] of ambientClauses(rule.condition)) {
		if (!ctx.timers.has(timer)) {
			return fail(`condition references unknown timer '${timer}'`);
		}
	}

	// The counter-value predicate (ADR 0015) names counter *definitions*, checked against
	// the same set an effect's counter target is — and refused for the same
	// reason. An unknown counter never resolves to a value, so the clause would
	// read as permanently unmet and hold the rule shut for ever, invisibly. The
	// clause shape itself needs no check: `comparisonClauseSchema` already
	// constrains it to a numeric comparison, and a counter is always a number, so
	// there is no field-kind mismatch to catch the way metadata has.
	for (const [counter] of counterClauses(rule.condition)) {
		if (!ctx.counters.has(counter)) {
			return fail(`condition references unknown counter '${counter}'`);
		}
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
			return (
				checkDeltaTarget(effect, ctx, type) ??
				// A routed magnitude must name a field that can actually hold one
				// (ADR 0015). Beside the other routed keys because it is one: at
				// runtime an absent key routes `undefined`, which degrades the effect
				// somewhere invisible instead of failing somewhere visible.
				checkRoutedKey("by_from", effect.by_from, type, ["number"], {
					magnitude: true,
				})
			);
		case "reset_counter":
			return checkCounterTarget(effect.counter, ctx);
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
				// A tag is display text on the timer row, so any field that reads as a
				// short label can supply it — including `text`, which is what a minted
				// ref's human name now lives in (`task_name`, ADR 0005).
				checkRoutedKey("tag_from", effect.tag_from, type, [
					"enum",
					"ref",
					"text",
				]) ??
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
 * Ensures an effect's counter target is one the couple actually has. Shared by
 * the three counter verbs so the error reads the same whichever one names a
 * counter that isn't there.
 */
function checkCounterTarget(
	counter: string,
	ctx: RuleValidationContext,
): string | null {
	return ctx.counters.has(counter)
		? null
		: `effect targets unknown counter '${counter}'`;
}

/**
 * Ensures a delta effect names its counter exactly one way (ADR 0017): a literal
 * `counter` the couple holds, or a `counter_from` routing one off the event.
 *
 * **Exactly one**, checked here rather than given a precedence order in the
 * engine. A rule carrying both is two answers to one question, and whichever lost
 * would lose silently — the author would read the literal in the editor and watch
 * a different counter move.
 *
 * A routed target demands more of its field than a routed magnitude does of its
 * own: it must be a **ref**, because a counter id is an identity rather than a
 * label, and it must be `required`, because a magnitude field may legitimately be
 * blank while a target that is absent names no projection at all. That second
 * demand is what keeps the runtime skip a can't-happen guard instead of a live
 * path nobody sees.
 */
function checkDeltaTarget(
	effect: Extract<
		Rule["effects"][number],
		{ verb: "increment_counter" | "decrement_counter" }
	>,
	ctx: RuleValidationContext,
	type: EventType,
): string | null {
	if (effect.counter !== undefined && effect.counter_from !== undefined) {
		return "effect names both a counter and a counter_from — pick one";
	}
	if (effect.counter_from === undefined) {
		return effect.counter === undefined
			? "effect needs a counter, or a counter_from to route one"
			: checkCounterTarget(effect.counter, ctx);
	}
	const routed = checkRoutedKey("counter_from", effect.counter_from, type, [
		"ref",
	]);
	if (routed) return routed;
	return type.metadata[effect.counter_from]?.required === true
		? null
		: `effect counter_from key '${effect.counter_from}' on ${type.id} must be a required field`;
}

/**
 * Ensures a routed event key (`tag_from`, `duration_from`, `by_from`) exists on
 * the triggering type and is a field kind the routing can actually use.
 *
 * `require.magnitude` is the extra demand a **routed magnitude** makes
 * (ADR 0015) — see {@link checkMagnitudeField}. Expressed as an option rather
 * than a separate check so the failures read as one family: a routing that
 * cannot work is refused here, at creation, whichever way it cannot work.
 */
function checkRoutedKey(
	label: string,
	key: string | undefined,
	type: EventType,
	kinds: MetadataField["kind"][],
	require?: { magnitude: boolean },
): string | null {
	if (key === undefined) return null;
	const field = type.metadata[key];
	if (!field) {
		return `effect ${label} references unknown key '${key}' on ${type.id}`;
	}
	if (!kinds.includes(field.kind)) {
		return `effect ${label} key '${key}' on ${type.id} must be a ${kinds.join(" or ")} field`;
	}
	if (require?.magnitude) {
		return checkMagnitudeField(label, key, type, field);
	}
	return null;
}

/**
 * Ensures a field can hold a **magnitude** — an amount, and only an amount
 * (ADR 0015). Two demands, and the second is the one the first invites you to
 * forget:
 *
 * **Whole**, because the counter it lands in is: `increment_counter.by` is
 * `z.number().int()` and a fraction would drive the counter cache non-integer
 * and break reads and export somewhere nobody is looking.
 *
 * **Non-negative**, because the *verb* carries the direction. `increment_counter`
 * with a routed `-3` subtracts, so the rule's own verb and the couple's counter
 * disagree and nothing reports it; the trace then reads `+-3 demerits`, since
 * `phraseCounter` prepends the sign the verb implies. ADR 0015 put direction on
 * the definition — "`by` is already a weight … and `valence` is already its
 * direction" — and a routed amount must not be able to move it, because the
 * person who *logs* the event is not always the person who authored the rule.
 *
 * Declared rather than observed: the field must carry `min` at 0 or above, so
 * `checkMetadataValue`'s existing bound enforcement keeps the negative out on
 * both write paths. A field that merely happens never to receive one is not a
 * magnitude field, and a runtime clamp would invent a number nobody wrote — the
 * same objection ADR 0015 raised against rounding.
 */
function checkMagnitudeField(
	label: string,
	key: string,
	type: EventType,
	field: MetadataField,
): string | null {
	// Unreachable: `kinds` is `["number"]` wherever a magnitude is required, and
	// that check has already run. Kept so the narrowing is the compiler's, not a
	// cast, if a future caller widens `kinds`.
	if (field.kind !== "number") {
		return `effect ${label} key '${key}' on ${type.id} must be a number field`;
	}
	if (!field.integer) {
		return `effect ${label} key '${key}' on ${type.id} must be declared integer — a counter cannot hold a fraction`;
	}
	if (field.min === undefined || field.min < 0) {
		return `effect ${label} key '${key}' on ${type.id} must declare min 0 or higher — the effect's verb carries the direction, so a routed amount must not be able to invert it`;
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

/**
 * Ensures a comparison clause (ADR 0011) sits on a `number` field. Ordering an
 * enum or a ref is the kind of thing that reads plausibly in an editor and then
 * means nothing at runtime — `severity > "major"` has no answer — so it is
 * refused at creation, beside the unknown-key errors, rather than never matching
 * for the rest of the couple's life.
 */
function checkComparison(key: string, field: MetadataField): string | null {
	return field.kind === "number"
		? null
		: `condition on '${key}' compares a ${field.kind} field; only numbers can be compared`;
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
		case "text":
			return typeof value === "string"
				? null
				: `condition on '${key}' must be text`;
		case "ref":
			return typeof value === "string"
				? null
				: `condition on '${key}' must be a reference`;
	}
}

function fail(error: string): RuleValidation {
	return { ok: false, error };
}
