import type { CounterDefinition } from "./counters.ts";
import type { EventType } from "./event-types.ts";
import { isCitingRef } from "./refs.ts";
import type { Rule } from "./rules.ts";

/**
 * Tracking a ritual (#121, ADR 0006 — "Agreements scaffold Rules; they do not
 * own them").
 *
 * Per-ritual history needs three artifacts working together: a counter with a
 * daily target, a streak folding it, and a rule pointing the ritual's citation at
 * the counter. #114 refused to ship that as a documented recipe — it "hands the
 * couple a footgun and calls it a feature" — because assembling it by hand means
 * the same identifier typed into three places, and one typo makes a rule that
 * looks right and silently matches nothing.
 *
 * So the app assembles it. **Once**: what comes out is ordinary counters and an
 * ordinary rule, with no stored link back and no cascade. Nothing here is a
 * relationship, only a starting point — which is why the plan is a pure function
 * of the Agreement, and why the same function feeds both the preview the dom
 * confirms and the artifacts the server creates. Two derivations would let the
 * confirmation describe something other than what gets made.
 */

/** What tracking a ritual will create — the preview and the instruction, as one. */
export interface ScaffoldPlan {
	counter: CounterDefinition;
	streak: CounterDefinition;
	rule: Rule;
}

/**
 * The artifacts for tracking one ritual Agreement.
 *
 * Ids derive from the Agreement's own, which is already a minted ULID, so they
 * are unique without consulting anything — and readable enough in the counters
 * list because the *names* carry the term's wording. The rule cites the
 * Agreement by id (`ritual_id = <agreement>`), which is the whole point: both
 * sides of that equality are picks, so the identifier can never drift.
 */
export function scaffoldPlan({
	agreementId,
	name,
	eventTypeId,
	refKey,
}: {
	agreementId: string;
	/** The term's name in force, used for the human-facing counter names. */
	name: string;
	/** The event type whose citation drives the counter (`ritual_completed`). */
	eventTypeId: string;
	/** The citing-ref key on that type (`ritual_id`). */
	refKey: string;
}): ScaffoldPlan {
	const counterId = `${agreementId}_today`;
	return {
		counter: {
			id: counterId,
			name,
			valence: "positive",
			daily_target: 1,
			// A scaffolded ritual counter is a floor — "did it at least once today"
			// (ADR 0015). A cap is the mercy shape, and it belongs to a counter the
			// couple defines deliberately, not to one a citation scaffolds for them.
			target_direction: "floor",
			reset: "daily",
			// No ladder, for the reason the pack ships none (ADR 0015): a consequence
			// is a term the couple agrees, and scaffolding one off a citation would
			// have the app assert a consequence nobody consented to.
			rungs: [],
			modify_permission: ["dom", "sub", "switch"],
		},
		streak: {
			id: `${agreementId}_streak`,
			name: `${name} streak`,
			valence: "positive",
			target_direction: "floor",
			reset: "never",
			// A streak is a property of its target counter (CONTEXT §Target counter),
			// expressed here as the fold the DO's rollover alarm reads — never a rule.
			streak: { counter: counterId, period: "daily" },
			rungs: [],
			modify_permission: ["dom", "sub", "switch"],
		},
		rule: {
			id: `track_${agreementId}`,
			// Named from the term for the same reason the counters are (#150): the id
			// is a ULID, and "Edit track_01J8…" is what #150 was filed about.
			name: `Track ${name}`,
			enabled: true,
			condition: { type: eventTypeId, metadata: { [refKey]: agreementId } },
			effects: [{ verb: "increment_counter", counter: counterId, by: 1 }],
		},
	};
}

/**
 * The citing-ref key on a type that names an Agreement, or null if it has none.
 *
 * Read from the schema rather than hardcoded, so a couple's own ritual-shaped
 * event type can be tracked the day they write it — the same derivation the
 * composer's picker and the targets panel already make.
 */
export function citingKeyOf(type: EventType): string | null {
	for (const [key, field] of Object.entries(type.metadata)) {
		if (field.kind === "ref" && isCitingRef(field)) return key;
	}
	return null;
}

/**
 * The event type whose citation can count this kind of Agreement, with the key
 * that does it — or null when nothing cites the kind.
 *
 * The **one** derivation: the server builds the plan from it and the screen
 * builds its preview from it, so the confirmation cannot describe something
 * other than what gets made. Hardcoding `ritual_completed`/`ritual_id` on either
 * side would be a second derivation wearing a constant, and would quietly
 * mis-describe a couple's own ritual-shaped type.
 *
 * The match is on a **declared** `agreement_kind` and nothing else (#213). This
 * used to also accept a citing ref that declared no kind at all, reading an
 * absent narrowing as "counts anything" — and the pack ships exactly such a
 * field: `infraction.rule_ref`, unqualified on purpose, because a breach may
 * cite any term the couple wrote. So "what counts a limit?" resolved to
 * `infraction`, and the scaffold built from that answer gave a limit a
 * positive-valence daily target of **1**, a `floor` direction and a streak — a
 * goal of one breach a day, with a run of consecutive days of breaking your own
 * boundary, rendered on Today as met at 1/1. The same held for protocols and
 * safewords, which is every kind but the one this was written for.
 *
 * The defect was a conflation, not a typo: *"cite anything"* and *"count this
 * kind"* are different statements, and only the second is an answer to the
 * question asked here. Requiring the declaration makes countability something a
 * type states on purpose rather than something that falls out of leaving a field
 * off — which is the right default for a mechanism whose failure mode is
 * inventing a target nobody asked for.
 *
 * This restores a decision rather than making one. ADR 0006 already settled it —
 * "you do not tick a limit… the only tickable kind is `ritual`" — so the code was
 * contradicting its own ADR, which is why nothing here needed re-deciding and no
 * ADR is amended.
 *
 * A couple's own ritual-shaped type is still tracked the day they write it; it
 * declares the kind it counts, exactly as `ritual_completed` does.
 */
export function countingTypeFor(
	kindId: string,
	types: EventType[],
): { type: EventType; refKey: string } | null {
	for (const type of types) {
		const refKey = citingKeyOf(type);
		if (!refKey) continue;
		const field = type.metadata[refKey];
		if (field.kind !== "ref") continue;
		if (field.agreement_kind === kindId) {
			return { type, refKey };
		}
	}
	return null;
}

/**
 * Whether some rule already points this Agreement at a counter — i.e. it is
 * already tracked.
 *
 * Derived rather than stored, because ADR 0006 chose not to keep a link: the
 * rule *is* the record that tracking happened. That also means a couple who
 * builds the recipe by hand is recognised as tracking it, and a couple who
 * deletes the rule is offered tracking again — both of which are right, and
 * neither of which a stored flag would get correct.
 */
export function isTracked(
	agreementId: string,
	rules: Rule[],
	types: EventType[],
): boolean {
	const byId = new Map(types.map((t) => [t.id, t]));
	return rules.some((rule) => {
		if (rule.enabled === false) return false;
		if (!rule.effects.some((e) => e.verb === "increment_counter")) return false;
		const type = byId.get(rule.condition.type);
		if (!type) return false;
		// A *citation* of this term, not any value that happens to equal its id:
		// the same question `tickFor` asks before offering a tick, so the two
		// cannot disagree about whether a ritual is being counted.
		return Object.entries(rule.condition.metadata).some(([key, value]) => {
			const field = type.metadata[key];
			return value === agreementId && field !== undefined && isCitingRef(field);
		});
	});
}
