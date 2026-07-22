import {
	type Rule,
	type RuleVersion,
	ruleFromVersion,
	type VersionedRule,
} from "./rules.ts";

/**
 * Adopt-on-edit pack reconciliation (ADR 0002, spec #64). When the shipped rule
 * pack bumps, a couple's installed set must move forward without clobbering the
 * tuning they chose. This pure function diffs the shipped pack against the
 * couple's installed rules and returns the decision the DO's seeding path
 * applies — it touches no storage and reads no clock (the effective-from stamp is
 * passed in), so it is unit-testable in plain Node.
 *
 * The three outcomes (ADR 0002):
 * - **add** — a pack rule the couple does not have yet is installed. Also the
 *   initial-seed case: against an empty installed set every pack rule is added.
 * - **upsert** — an *un-adopted* pack rule whose shipped definition changed gets a
 *   new effective-dated version appended (never a replace: old events still
 *   replay under the definition in force when they were logged).
 * - **skip** — an *adopted* pack rule (one the couple has edited) is frozen; the
 *   bump never overwrites it. `changedUpstream` flags when the new pack definition
 *   differs from the couple's current one, so the partner can be offered the new
 *   default rather than having it silently applied.
 *
 * An un-adopted rule whose shipped definition is unchanged produces no entry in
 * any bucket — a bump that doesn't touch a rule is a no-op for it.
 */
export interface PackReconciliation {
	/** Brand-new pack rules to install (present in the pack, absent from the couple). */
	added: VersionedRule[];
	/** Un-adopted pack rules whose definition changed upstream — a version to append. */
	upserted: Array<{ id: string; version: RuleVersion }>;
	/** Adopted pack rules left frozen; `changedUpstream` drives the new-default notice. */
	skipped: Array<{ id: string; changedUpstream: boolean }>;
}

/**
 * Reconciles the shipped `pack` against the couple's `installed` rules, stamping
 * any appended/installed version with `effectiveFrom` (the log-time of the bump,
 * or the couple's creation time on an initial seed). Custom rules the couple
 * authored are ignored entirely — the pack only reconciles its own `R#` rules.
 */
export function reconcilePack(
	pack: readonly Rule[],
	installed: readonly VersionedRule[],
	effectiveFrom: number,
): PackReconciliation {
	const byId = new Map(installed.map((rule) => [rule.id, rule]));
	const reconciliation: PackReconciliation = {
		added: [],
		upserted: [],
		skipped: [],
	};

	for (const packRule of pack) {
		const current = byId.get(packRule.id);
		if (!current) {
			reconciliation.added.push(installedFromPackRule(packRule, effectiveFrom));
			continue;
		}

		const changedUpstream = !sameDefinition(packRule, currentRule(current));
		if (current.adopted) {
			// The couple edited this rule — never overwrite it, only flag a new default.
			reconciliation.skipped.push({ id: packRule.id, changedUpstream });
		} else if (changedUpstream) {
			// Still tracking the pack: append the new definition, forward-only.
			reconciliation.upserted.push({
				id: packRule.id,
				version: versionFromPackRule(packRule, effectiveFrom),
			});
		}
	}
	return reconciliation;
}

/** The current (latest) definition of an installed rule, flattened for comparison. */
function currentRule(rule: VersionedRule): Rule {
	const latest = rule.versions.reduce((a, b) =>
		b.effective_from >= a.effective_from ? b : a,
	);
	return ruleFromVersion(rule.id, latest);
}

/** A fresh single-version pack rule to install. */
function installedFromPackRule(
	rule: Rule,
	effectiveFrom: number,
): VersionedRule {
	return {
		id: rule.id,
		origin: "pack",
		adopted: false,
		versions: [versionFromPackRule(rule, effectiveFrom)],
	};
}

/** One effective-dated version carrying a pack rule's definition. */
function versionFromPackRule(rule: Rule, effectiveFrom: number): RuleVersion {
	return {
		effective_from: effectiveFrom,
		condition: rule.condition,
		effects: rule.effects,
		enabled: rule.enabled,
	};
}

/**
 * Whether two rules carry the same definition — condition, effects, and enabled
 * flag. Ignores id and effective_from (which are not part of "what the rule
 * does"). Structural and key-order-independent, so a re-serialized metadata
 * record or effect list doesn't read as a spurious upstream change.
 */
function sameDefinition(a: Rule, b: Rule): boolean {
	return (
		a.enabled === b.enabled &&
		stable(a.condition) === stable(b.condition) &&
		stable(a.effects) === stable(b.effects)
	);
}

/** Deterministic JSON with object keys sorted at every level. */
function stable(value: unknown): string {
	return JSON.stringify(value, (_key, val) => {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			return Object.fromEntries(
				Object.entries(val as Record<string, unknown>).sort(([x], [y]) =>
					x < y ? -1 : x > y ? 1 : 0,
				),
			);
		}
		return val;
	});
}
