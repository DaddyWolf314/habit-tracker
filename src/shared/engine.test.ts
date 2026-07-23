import { describe, expect, it } from "vitest";
import {
	evaluateRules,
	matchRule,
	type RuleEventContext,
	reevaluate,
} from "./engine.ts";
import type { Rule } from "./rules.ts";

/** A rule with sensible defaults for the fields a test doesn't care about. */
function rule(partial: Partial<Rule> & Pick<Rule, "id" | "condition">): Rule {
	return {
		effects: [{ verb: "increment_counter", counter: "x", by: 1 }],
		enabled: true,
		...partial,
	};
}

function ctx(
	type: string,
	metadata: RuleEventContext["metadata"] = {},
): RuleEventContext {
	return { type, metadata, occurred_at: 1000 };
}

describe("condition matching (handoff §4.3)", () => {
	it("matches on type alone when there are no metadata conditions", () => {
		const r = rule({
			id: "R1",
			condition: { type: "ritual_completed", metadata: {} },
		});
		expect(matchRule(r, ctx("ritual_completed"))).toEqual({ status: "fired" });
	});

	it("ignores a rule whose type does not match (not even a near-miss)", () => {
		const r = rule({
			id: "R1",
			condition: { type: "ritual_completed", metadata: {} },
		});
		expect(matchRule(r, ctx("orgasm"))).toEqual({ status: "irrelevant" });
	});

	it("matches when every metadata equality condition holds", () => {
		const r = rule({
			id: "R2",
			condition: { type: "ritual_completed", metadata: { late: true } },
		});
		expect(matchRule(r, ctx("ritual_completed", { late: true }))).toEqual({
			status: "fired",
		});
	});

	it("equality is strict across kinds (boolean, number, enum string)", () => {
		const r = rule({
			id: "R9",
			condition: {
				type: "infraction",
				metadata: { severity: "minor", self_reported: false },
			},
		});
		expect(
			matchRule(
				r,
				ctx("infraction", { severity: "minor", self_reported: false }),
			),
		).toEqual({ status: "fired" });
	});
});

describe("silent skip + near-miss (handoff §4.3, §4.6)", () => {
	it("an absent condition key is a silent skip recorded as a near-miss", () => {
		const r = rule({
			id: "R12",
			condition: { type: "orgasm", metadata: { permitted: false } },
		});
		// permitted is awaiting (unset) — the load-bearing skip.
		const result = matchRule(r, ctx("orgasm", { outcome: "denied" }));
		expect(result.status).toBe("near_miss");
		if (result.status !== "near_miss") throw new Error("unreachable");
		expect(result.awaiting).toEqual(["permitted"]);
		expect(result.reason).toContain("permitted");
		expect(result.reason).toContain("R12");
	});

	it("a present-but-unequal key is a near-miss but not awaiting", () => {
		const r = rule({
			id: "R11",
			condition: {
				type: "orgasm",
				metadata: { permitted: true, outcome: "full" },
			},
		});
		const result = matchRule(
			r,
			ctx("orgasm", { permitted: false, outcome: "full" }),
		);
		expect(result.status).toBe("near_miss");
		if (result.status !== "near_miss") throw new Error("unreachable");
		// permitted is set (to the wrong value), so it is not "waiting on" anything.
		expect(result.awaiting).toEqual([]);
		expect(result.reason).toContain("permitted");
	});

	it("reports multiple unmet keys, separating awaiting from mismatched", () => {
		const r = rule({
			id: "R9",
			condition: {
				type: "infraction",
				metadata: { severity: "minor", self_reported: false },
			},
		});
		// severity awaiting (unset); self_reported present but wrong.
		const result = matchRule(r, ctx("infraction", { self_reported: true }));
		expect(result.status).toBe("near_miss");
		if (result.status !== "near_miss") throw new Error("unreachable");
		expect(result.awaiting).toEqual(["severity"]);
	});
});

describe("evaluateRules", () => {
	const rules: Rule[] = [
		rule({ id: "R10", condition: { type: "orgasm", metadata: {} } }),
		rule({
			id: "R11",
			condition: {
				type: "orgasm",
				metadata: { permitted: true, outcome: "full" },
			},
		}),
		rule({
			id: "R12",
			condition: { type: "orgasm", metadata: { permitted: false } },
		}),
		rule({ id: "R1", condition: { type: "ritual_completed", metadata: {} } }),
	];

	it("splits the relevant rules into fired and near-miss, ignoring the rest", () => {
		// Orgasm logged by sub with permitted unset: R10 fires, R11/R12 wait.
		const { fired, nearMisses } = evaluateRules(
			rules,
			ctx("orgasm", { outcome: "full" }),
		);
		expect(fired.map((f) => f.rule_id)).toEqual(["R10"]);
		expect(nearMisses.map((n) => n.rule_id).sort()).toEqual(["R11", "R12"]);
		// R1 (ritual) is irrelevant to an orgasm event — absent from both lists.
	});

	it("with awaiting context, surfaces only near-misses pending on an awaiting key", () => {
		// orgasm awaits `permitted`; R11/R12 wait on it, so both surface. A near-miss
		// on a non-awaiting key (or a wrong value) would be noise and is dropped.
		const noisy = [
			...rules,
			rule({
				id: "RN",
				condition: { type: "orgasm", metadata: { outcome: "ruined" } },
			}),
		];
		const { nearMisses } = evaluateRules(noisy, {
			type: "orgasm",
			metadata: { outcome: "full" },
			occurred_at: 1,
			awaiting: ["permitted"],
		});
		// RN is a wrong-value miss on `outcome` (set, not awaiting) — dropped.
		expect(nearMisses.map((n) => n.rule_id).sort()).toEqual(["R11", "R12"]);
	});

	it("without awaiting context, surfaces every near-miss (pure evaluation)", () => {
		const { nearMisses } = evaluateRules(
			rules,
			ctx("orgasm", { outcome: "full" }),
		);
		expect(nearMisses.map((n) => n.rule_id).sort()).toEqual(["R11", "R12"]);
	});

	it("disabled rules never fire and are not evaluated", () => {
		const withDisabled = [
			...rules,
			rule({
				id: "RX",
				condition: { type: "orgasm", metadata: {} },
				enabled: false,
			}),
		];
		const { fired } = evaluateRules(
			withDisabled,
			ctx("orgasm", { outcome: "full" }),
		);
		expect(fired.map((f) => f.rule_id)).not.toContain("RX");
	});
});

describe("reevaluate on amendment (handoff §4.2, §7)", () => {
	const rules = [
		// Unconditional on the type — fires at append time, before any ruling.
		rule({
			id: "Runc",
			condition: { type: "orgasm", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "orgasms", by: 1 }],
		}),
		// Conditional — waits (near-miss) until `permitted` is ruled true.
		rule({
			id: "Rperm",
			condition: { type: "orgasm", metadata: { permitted: true } },
			effects: [
				{ verb: "increment_counter", counter: "permitted", by: 1 },
				{ verb: "reset_anchor", anchor: "since_orgasm" },
			],
		}),
		// Conditional — the opposite ruling.
		rule({
			id: "Runp",
			condition: { type: "orgasm", metadata: { permitted: false } },
			effects: [{ verb: "increment_counter", counter: "unpermitted", by: 1 }],
		}),
	];

	it("fires a rule that was pending, not the ones already fired at append", () => {
		const fired = reevaluate(
			rules,
			ctx("orgasm", {}), // permitted unset — only Runc had fired
			ctx("orgasm", { permitted: true }),
		);
		expect(fired.map((f) => f.rule_id)).toEqual(["Rperm"]);
	});

	it("resolves anchor ops to the target's occurred_at, not the ruling time", () => {
		const fired = reevaluate(
			rules,
			ctx("orgasm", {}),
			ctx("orgasm", { permitted: true }),
		);
		const anchorOp = fired[0].ops.find((o) => o.kind === "anchor");
		expect(anchorOp).toEqual({
			kind: "anchor",
			anchor: "since_orgasm",
			at: 1000,
		});
	});

	it("a correction fires the newly-matching rule, not the superseded one", () => {
		const fired = reevaluate(
			rules,
			ctx("orgasm", { permitted: true }), // Rperm had fired
			ctx("orgasm", { permitted: false }), // now Runp matches
		);
		expect(fired.map((f) => f.rule_id)).toEqual(["Runp"]);
	});

	it("fires nothing when composite state is unchanged", () => {
		expect(
			reevaluate(
				rules,
				ctx("orgasm", { permitted: true }),
				ctx("orgasm", { permitted: true }),
			),
		).toEqual([]);
	});
});

describe("subject-role qualifier (ADR 0003)", () => {
	const domRule = rule({
		id: "Rdom",
		condition: { type: "orgasm", subject_role: "dom", metadata: {} },
	});
	const subRule = rule({
		id: "Rsub",
		condition: { type: "orgasm", subject_role: "sub", metadata: {} },
	});

	function subjectCtx(
		subjectRole: RuleEventContext["subject_role"],
		metadata: RuleEventContext["metadata"] = {},
	): RuleEventContext {
		return {
			type: "orgasm",
			metadata,
			occurred_at: 1000,
			subject_role: subjectRole,
		};
	}

	it("fires only when the event's subject resolves to the qualified role", () => {
		expect(matchRule(domRule, subjectCtx("dom"))).toEqual({ status: "fired" });
		expect(matchRule(subRule, subjectCtx("sub"))).toEqual({ status: "fired" });
	});

	it("a wrong subject role is a near-miss with plain-language phrasing", () => {
		expect(matchRule(subRule, subjectCtx("dom"))).toEqual({
			status: "near_miss",
			reason: "Rsub didn't fire: subject is not the sub",
			awaiting: [],
			subject_mismatch: true,
		});
	});

	it("an event with no subject never matches a qualified rule", () => {
		expect(matchRule(domRule, ctx("orgasm"))).toMatchObject({
			status: "near_miss",
			subject_mismatch: true,
		});
	});

	it("dom/sub qualifiers are dormant in a switch/switch couple", () => {
		// Both members are `switch`, so no subject ever resolves to dom or sub.
		expect(matchRule(domRule, subjectCtx("switch")).status).toBe("near_miss");
		expect(matchRule(subRule, subjectCtx("switch")).status).toBe("near_miss");
		// A switch-qualified custom rule does match.
		const switchRule = rule({
			id: "Rsw",
			condition: { type: "orgasm", subject_role: "switch", metadata: {} },
		});
		expect(matchRule(switchRule, subjectCtx("switch")).status).toBe("fired");
	});

	it("an unqualified rule matches regardless of subject role", () => {
		const plain = rule({
			id: "R",
			condition: { type: "orgasm", metadata: {} },
		});
		expect(matchRule(plain, subjectCtx("dom")).status).toBe("fired");
		expect(matchRule(plain, ctx("orgasm")).status).toBe("fired");
	});

	it("a subject mismatch is terminal: no metadata keys are 'awaited'", () => {
		// The subject is fixed at logging, so a ruling can never make this rule
		// fire — reporting "waiting on: permitted" would be a false promise.
		const conditional = rule({
			id: "Rc",
			condition: {
				type: "orgasm",
				subject_role: "sub",
				metadata: { permitted: true },
			},
		});
		const result = matchRule(conditional, subjectCtx("dom"));
		expect(result).toMatchObject({ status: "near_miss", awaiting: [] });
	});

	it("subject-mismatch near-misses surface even under the awaiting filter", () => {
		// Structural dormancy must stay legible in the trace ("why didn't the
		// sub's rules fire on the dom's orgasm") even though nothing is awaited.
		const { nearMisses } = evaluateRules([subRule], {
			...subjectCtx("dom"),
			awaiting: ["permitted"],
		});
		expect(nearMisses.map((n) => n.rule_id)).toEqual(["Rsub"]);
	});

	it("reevaluate honors the qualifier: a ruling cannot un-dormant a rule", () => {
		const conditional = rule({
			id: "Rc",
			condition: {
				type: "orgasm",
				subject_role: "sub",
				metadata: { permitted: true },
			},
		});
		// Dom-subject orgasm ruled permitted=true: the sub-qualified rule still
		// never fires — the qualifier is checked identically on re-evaluation.
		const fired = reevaluate(
			[conditional],
			subjectCtx("dom"),
			subjectCtx("dom", { permitted: true }),
		);
		expect(fired).toEqual([]);
	});
});
