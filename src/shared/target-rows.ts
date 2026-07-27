import type { Counter } from "./counters.ts";
import type { EventType } from "./event-types.ts";
import { isCitingRef } from "./refs.ts";
import type { MetadataValue } from "./roles.ts";
import type { Rule } from "./rules.ts";

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
	/** Days (or weeks) of the streak folding this counter, or null if none does. */
	streak: number | null;
	met: boolean;
	/**
	 * The event a tick should log, when the rules say what this counter counts.
	 * Null leaves the row a readout — see {@link tickFor}.
	 */
	logs: { type: string; metadata: Record<string, MetadataValue> } | null;
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
			streak:
				counters.find((c) => c.streak?.counter === counter.id)?.value ?? null,
			met: counter.value >= target,
			logs: tickFor(counter.id, rules, types),
		});
	}
	return rows;
}

/**
 * The event a tick on this counter's row should log, or null when there is
 * nothing honest to log.
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
 */
function tickFor(
	counterId: string,
	rules: Rule[],
	types: EventType[],
): TargetRow["logs"] {
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		const increments = rule.effects.some(
			(e) => e.verb === "increment_counter" && e.counter === counterId,
		);
		if (!increments) continue;
		const type = types.find((t) => t.id === rule.condition.type);
		if (!type) continue;
		const clauses = Object.entries(rule.condition.metadata);
		if (clauses.length === 0) continue;
		const allCite = clauses.every(([key]) => {
			const field = type.metadata[key];
			return field !== undefined && isCitingRef(field);
		});
		if (!allCite) continue;
		return { type: type.id, metadata: { ...rule.condition.metadata } };
	}
	return null;
}
