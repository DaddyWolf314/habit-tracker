import { describe, expect, it } from "vitest";
import {
	evaluateRules,
	type RuleEventContext,
	reevaluate,
	rulesEffectiveAt,
} from "./engine.ts";
import type { RuleVersion, VersionedRule } from "./rules.ts";

/**
 * Effective-dated resolution and forward-only replay (ADR 0002, spec #64). These
 * assert external behavior — given versioned rules and a log-time, the resolved
 * set and the fired outcome — never a private field or call order. The resolver
 * feeds the *unchanged* `evaluateRules` / `reevaluate`, so a rebuild reproduces
 * history and a late ruling cannot smuggle in a newer rule version.
 */

const demeritBy = (by: number) =>
	[{ verb: "increment_counter" as const, counter: "demerits", by }] as const;

function version(
	effective_from: number,
	partial: Partial<RuleVersion> = {},
): RuleVersion {
	return {
		effective_from,
		condition: { type: "ritual_completed", metadata: { late: true } },
		effects: [...demeritBy(1)],
		enabled: true,
		...partial,
	};
}

function versionedRule(
	partial: Partial<VersionedRule> & Pick<VersionedRule, "id" | "versions">,
): VersionedRule {
	return { origin: "custom", adopted: false, ...partial };
}

function ctx(
	type = "ritual_completed",
	metadata: RuleEventContext["metadata"] = { late: true },
): RuleEventContext {
	return { type, metadata, occurred_at: 1000 };
}

describe("rulesEffectiveAt — version selection", () => {
	it("a rule with one version behaves as before at any later log-time", () => {
		const rules = [versionedRule({ id: "R2", versions: [version(0)] })];
		expect(rulesEffectiveAt(rules, 5_000)).toEqual([
			{
				id: "R2",
				condition: { type: "ritual_completed", metadata: { late: true } },
				effects: demeritBy(1),
				enabled: true,
			},
		]);
	});

	it("picks the latest version at or before the log-time", () => {
		const rules = [
			versionedRule({
				id: "R2",
				versions: [
					version(0, { effects: [...demeritBy(1)] }),
					version(1_000, { effects: [...demeritBy(2)] }),
				],
			}),
		];
		expect(rulesEffectiveAt(rules, 500)[0]?.effects).toEqual(demeritBy(1));
		expect(rulesEffectiveAt(rules, 5_000)[0]?.effects).toEqual(demeritBy(2));
	});

	it("is inclusive at the effective_from boundary", () => {
		const rules = [
			versionedRule({
				id: "R2",
				versions: [
					version(0, { effects: [...demeritBy(1)] }),
					version(1_000, { effects: [...demeritBy(2)] }),
				],
			}),
		];
		// Exactly at the boundary the new version is in force.
		expect(rulesEffectiveAt(rules, 1_000)[0]?.effects).toEqual(demeritBy(2));
		// One tick before, the old version still holds.
		expect(rulesEffectiveAt(rules, 999)[0]?.effects).toEqual(demeritBy(1));
	});

	it("omits a rule whose earliest version begins after the log-time", () => {
		const rules = [
			versionedRule({ id: "custom-new", versions: [version(2_000)] }),
		];
		expect(rulesEffectiveAt(rules, 1_000)).toEqual([]);
		expect(rulesEffectiveAt(rules, 2_000)).toHaveLength(1);
	});

	it("selects the right version regardless of array order", () => {
		const rules = [
			versionedRule({
				id: "R2",
				versions: [
					version(1_000, { effects: [...demeritBy(2)] }),
					version(0, { effects: [...demeritBy(1)] }),
				],
			}),
		];
		expect(rulesEffectiveAt(rules, 500)[0]?.effects).toEqual(demeritBy(1));
	});
});

describe("rulesEffectiveAt — disable is effective-dated, not retroactive", () => {
	const disabledFromT: VersionedRule[] = [
		versionedRule({
			id: "R2",
			versions: [version(0), version(1_000, { enabled: false })],
		}),
	];

	it("still fires for an event logged before the disable took effect", () => {
		const resolved = rulesEffectiveAt(disabledFromT, 500);
		expect(evaluateRules(resolved, ctx()).fired.map((f) => f.rule_id)).toEqual([
			"R2",
		]);
	});

	it("stops firing for an event logged at or after the disable", () => {
		// Resolved to an enabled:false rule, which evaluateRules skips entirely.
		const resolved = rulesEffectiveAt(disabledFromT, 1_000);
		expect(resolved[0]?.enabled).toBe(false);
		expect(evaluateRules(resolved, ctx()).fired).toEqual([]);
	});
});

describe("forward-only replay (ADR 0002)", () => {
	// R2 shipped as +1, later edited to +2 at log-time 1_000.
	const edited: VersionedRule[] = [
		versionedRule({
			id: "R2",
			versions: [
				version(0, { effects: [...demeritBy(1)] }),
				version(1_000, { effects: [...demeritBy(2)] }),
			],
		}),
	];

	it("a past event replays under its log-time version — the edit does not rewrite it", () => {
		// An event logged at t=200, before the +2 edit, still scores +1 on rebuild.
		const fired = evaluateRules(rulesEffectiveAt(edited, 200), ctx()).fired;
		const by = fired[0]?.ops[0];
		expect(by).toMatchObject({ counter: "demerits", by: 1 });
	});

	it("a later event replays under the newer version", () => {
		const fired = evaluateRules(rulesEffectiveAt(edited, 5_000), ctx()).fired;
		expect(fired[0]?.ops[0]).toMatchObject({ counter: "demerits", by: 2 });
	});
});

describe("forward-only adjudication (ADR 0002)", () => {
	// A rule that only fires once an event is ruled `late`, edited +1 → +2 at 1_000.
	const rules: VersionedRule[] = [
		versionedRule({
			id: "R2",
			versions: [
				version(0, { effects: [...demeritBy(1)] }),
				version(1_000, { effects: [...demeritBy(2)] }),
			],
		}),
	];

	it("a late ruling on an old event fires the version in force at its log-time", () => {
		// The event was logged at t=200 (before the edit); the ruling happens later,
		// but re-evaluation must use the log-time version, not today's.
		const logTime = 200;
		const before = ctx("ritual_completed", {}); // not yet ruled late
		const after = ctx("ritual_completed", { late: true }); // ruled late now
		const fired = reevaluate(rulesEffectiveAt(rules, logTime), before, after);
		expect(fired.map((f) => f.rule_id)).toEqual(["R2"]);
		expect(fired[0]?.ops[0]).toMatchObject({ counter: "demerits", by: 1 });
	});
});
