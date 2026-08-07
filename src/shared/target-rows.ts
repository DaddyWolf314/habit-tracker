import { AGREEMENT_REF_KIND } from "./agreements.ts";
import type { Counter } from "./counters.ts";
import type { EventType } from "./event-types.ts";
import { citingRefKind, isCitingRef } from "./refs.ts";
import type { MetadataValue } from "./roles.ts";
import { isComparisonClause, type Rule } from "./rules.ts";
import { targetMet } from "./streaks.ts";

/**
 * What Today shows you are aiming at (#135, handoff §9.2 — "today's counter
 * targets"). Pure and dependency-free like `ref-candidates.ts`, and derived from
 * the same input for the same reason: the couple's own rules already state which
 * counter counts what, so a hardcoded list would go stale the moment they
 * scaffold a ritual.
 *
 * Only counters carrying a **target** appear. A counter without one cannot
 * answer "am I on track?", and the Log's counters panel already shows every
 * counter there is.
 */

/** One line on the targets panel: a target counter, its progress, and its tick. */
export interface TargetRow {
	counter: Counter;
	target: number;
	period: "daily" | "weekly";
	/**
	 * The streak folding this counter, with its period — a streak may be weekly,
	 * and one rendered as days would misstate it. Null when nothing folds it.
	 */
	streak: { length: number; period: "daily" | "weekly" } | null;
	met: boolean;
	/**
	 * What a tick on this row logs, when the rules say what this counter counts.
	 * Null leaves the row a readout — see {@link tickAndTerm}.
	 */
	tickLogs: { type: string; metadata: Record<string, MetadataValue> } | null;
	/**
	 * The **Agreement** this counter counts, or null when its rules cite none
	 * (#212 item 5).
	 *
	 * The provenance of a scaffolded counter, derived rather than stored — ADR
	 * 0006 keeps no link back, so the citing rule *is* the record that tracking
	 * happened, and reading it out is the same move in the same direction
	 * `isTracked` already makes in reverse. Falls out of the tick derivation
	 * rather than being a second scan, so a row can never name a term it would not
	 * log a citation of.
	 */
	tracks: string | null;
}

export function targetRows({
	counters,
	rules,
	types,
}: {
	counters: Counter[];
	rules: Rule[];
	types: EventType[];
}): TargetRow[] {
	// One pass to index the streaks, rather than a scan per row.
	const byStreakTarget = new Map<string, Counter>();
	for (const c of counters) {
		if (c.streak) byStreakTarget.set(c.streak.counter, c);
	}
	const rows: TargetRow[] = [];
	for (const counter of counters) {
		// A streak is a *property* of the counter it folds (CONTEXT §Target
		// counter), so it is read into that counter's row below and never given one
		// of its own — a sibling row would contradict the model on screen.
		if (counter.streak) continue;
		// Daily wins where both exist: the screen is Today, and a weekly figure
		// beside it answers a question nobody asked here.
		const daily = counter.daily_target;
		const target = daily ?? counter.weekly_target;
		if (target === undefined) continue;
		rows.push({
			counter,
			target,
			period: daily !== undefined ? "daily" : "weekly",
			streak: streakOf(counter.id, byStreakTarget),
			// Through the rollover's own predicate, not a local `>=` (ADR 0015): a cap
			// target is met by staying *under* it, and Today saying "met" where the
			// fold will say "broken" is the drift a shared function exists to prevent.
			met: targetMet(counter.value, target, counter.target_direction),
			...tickAndTerm(counter.id, rules, types),
		});
	}
	return rows;
}

/** The streak folding this counter, with its period, or null if none does. */
function streakOf(
	counterId: string,
	byStreakTarget: Map<string, Counter>,
): TargetRow["streak"] {
	const streak = byStreakTarget.get(counterId);
	if (!streak?.streak) return null;
	return { length: streak.value, period: streak.streak.period };
}

/**
 * What a tick on this counter's row should log, and the term it counts — or
 * nulls when there is nothing honest to say.
 *
 * The rule that increments a counter says what the counter counts, so it also
 * says what to append — the link #121's scaffolding deliberately did not store
 * (`when ritual_completed AND ritual_id = ag_X → increment ag_X_today`). Reading
 * it back out is the same move `ref-candidates.ts` makes: "which refs *have*
 * candidates is derived from the rules."
 *
 * The condition must match on a **citing ref** and nothing else. That is the
 * whole safety of the affordance: a citation is a term the couple wrote down, so
 * appending it asserts only what the tapper is already asserting by tapping. A
 * rule keyed on `late=true` would have a tick quietly claim the ritual was late.
 * A subject-role qualifier is fine — that governs *whose* event fires the rule,
 * not what is being asserted.
 *
 * Two enabled rules citing *different* terms into one counter make the tick
 * ambiguous, and the row goes read-only rather than picking one: a button that
 * silently asserts one of two rituals is worse than no button. Rules agreeing on
 * the same citation are not ambiguous and still tick.
 */
function tickAndTerm(
	counterId: string,
	rules: Rule[],
	types: EventType[],
): Pick<TargetRow, "tickLogs" | "tracks"> {
	const found = new Map<string, Pick<TargetRow, "tickLogs" | "tracks">>();
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		const increments = rule.effects.some(
			(e) => e.verb === "increment_counter" && e.counter === counterId,
		);
		if (!increments) continue;
		const type = types.find((t) => t.id === rule.condition.type);
		if (!type) continue;
		const clauses = Object.entries(rule.condition.metadata);
		// An unconditional rule (the pack's R1) says only "some ritual happened",
		// which names nothing a tick could cite.
		if (clauses.length === 0) continue;
		// Every clause must cite an Agreement by ref equality for the rule to name
		// what a tick would log. A comparison clause (ADR 0011) never can — it
		// constrains a number, and names nothing outside the event — so a rule
		// carrying one is not a citation, and the narrowing falls out of the check.
		const cited: Record<string, MetadataValue> = {};
		let allCite = true;
		// The corpus citation among them, for the row's provenance (#212 item 5).
		// Narrowed to the *Agreement* kind rather than taking any citing ref: the
		// set also holds the store (ADR 0017), and a row that counted redemptions
		// would otherwise claim to count a term.
		let term: string | null = null;
		for (const [key, value] of clauses) {
			const field = type.metadata[key];
			if (!field || !isCitingRef(field) || isComparisonClause(value)) {
				allCite = false;
				break;
			}
			cited[key] = value;
			if (
				citingRefKind(field) === AGREEMENT_REF_KIND &&
				typeof value === "string"
			) {
				// Only where the rule cites exactly one term. Two would make "what this
				// counts" ambiguous in the same way two rules do, and the row would be
				// picking one to name.
				term = term === null ? value : "";
			}
		}
		if (!allCite) continue;
		const tickLogs = { type: type.id, metadata: cited };
		// Keyed on what a tick would *log*, not on the term: two rules appending the
		// same citation are one answer, and they necessarily agree about the term.
		found.set(JSON.stringify(tickLogs), { tickLogs, tracks: term || null });
	}
	// Ambiguity kills both halves together. A row that could not honestly offer a
	// tick cannot honestly name what it counts either — they are the same claim.
	return found.size === 1
		? [...found.values()][0]
		: { tickLogs: null, tracks: null };
}
