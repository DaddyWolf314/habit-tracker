import { describe, expect, it } from "vitest";
import {
	evaluateRules,
	matchRule,
	NO_ACTIVE_TIMERS,
	NO_COUNTER_VALUES,
	type RuleEventContext,
	reevaluate,
	unfired,
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
	return {
		type,
		metadata,
		occurred_at: 1000,
		active_timers: NO_ACTIVE_TIMERS,
		counter_values: NO_COUNTER_VALUES,
	};
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
			active_timers: NO_ACTIVE_TIMERS,
			counter_values: NO_COUNTER_VALUES,
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

	/**
	 * The reversal counterpart (ADR 0016). This is where #184's limit was pinned:
	 * that issue's regression test asserted a correction leaves the superseded
	 * ruling's effects applied, and named #47 as the issue that would change it.
	 * #47 landed as ADR 0016, so the assertion inverts — a correction now names the
	 * rule that stopped matching so the caller can reverse what it did.
	 *
	 * What has *not* changed is `reevaluate` itself: it is still forward-only, and
	 * still returns only the newly-matching rule. That is the half of #184's limit
	 * that stands, and the split is the point.
	 */
	describe("unfired — the correction counterpart (ADR 0016)", () => {
		it("names the rule a correction stopped matching", () => {
			const before = ctx("orgasm", { permitted: true }); // Rperm had fired
			const after = ctx("orgasm", { permitted: false }); // now Runp matches
			expect(unfired(rules, before, after)).toEqual(["Rperm"]);
			// The forward direction is unchanged, and deliberately does not mention
			// Rperm: nothing is un-fired *here*.
			expect(reevaluate(rules, before, after).map((f) => f.rule_id)).toEqual([
				"Runp",
			]);
		});

		it("names a rule the correction unset rather than re-ruled", () => {
			// The #184 shape that is not a `supersedes`: a self-stated key the dom
			// overrides. Same mechanism, because the question is only "does it still
			// match", never how the metadata got there.
			expect(
				unfired(rules, ctx("orgasm", { permitted: true }), ctx("orgasm", {})),
			).toEqual(["Rperm"]);
		});

		it("names nothing on the always-safe unset → set transition", () => {
			// Nothing fired for a blank, so there is nothing to reverse — the one
			// transition #184 identified as safe, and the reason every shipped
			// amendment surface was safe by accident.
			expect(
				unfired(rules, ctx("orgasm", {}), ctx("orgasm", { permitted: true })),
			).toEqual([]);
		});

		it("never names a rule that fired both before and after", () => {
			// Runc is unconditional on the type: a correction to `permitted` has
			// nothing to say about it, and reversing it would undo an effect the
			// ruling never touched.
			expect(
				unfired(
					rules,
					ctx("orgasm", { permitted: true }),
					ctx("orgasm", { permitted: false }),
				),
			).not.toContain("Runc");
		});

		it("returns ids, never effects", () => {
			// The signature is the guard: what a rule *did* is the trace's answer, not
			// this module's, because the definition may have been edited since it
			// fired (ADR 0002).
			const result = unfired(
				rules,
				ctx("orgasm", { permitted: true }),
				ctx("orgasm", { permitted: false }),
			);
			expect(result.every((id) => typeof id === "string")).toBe(true);
		});
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
			active_timers: NO_ACTIVE_TIMERS,
			counter_values: NO_COUNTER_VALUES,
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

describe("ambient-state predicate (ADR 0011)", () => {
	const escalation = rule({
		id: "R26",
		condition: {
			type: "orgasm",
			metadata: { permitted: false },
			timer_active: { denial_period: true },
		},
	});

	function ambientCtx(
		active: string[],
		metadata: RuleEventContext["metadata"] = { permitted: false },
	): RuleEventContext {
		return {
			type: "orgasm",
			metadata,
			occurred_at: 1000,
			active_timers: new Set(active),
			counter_values: NO_COUNTER_VALUES,
		};
	}

	it("fires when the named timer is open", () => {
		expect(matchRule(escalation, ambientCtx(["denial_period"]))).toEqual({
			status: "fired",
		});
	});

	it("does not fire when it is closed, and says so without awaiting anything", () => {
		// The trace must be able to explain the silence, but no ruling on any key
		// will make a denial have been running — so the queue is never promised
		// a resolution that cannot arrive.
		const result = matchRule(escalation, ambientCtx([]));
		expect(result).toEqual({
			status: "near_miss",
			reason: "R26 didn't fire: denial_period not active",
			awaiting: [],
			state_mismatch: true,
		});
	});

	it("an unrelated open timer is not the one named", () => {
		expect(matchRule(escalation, ambientCtx(["task_countdown"])).status).toBe(
			"near_miss",
		);
	});

	it("negation matches only outside the timer", () => {
		const outside = rule({
			id: "Rout",
			condition: {
				type: "orgasm",
				metadata: {},
				timer_active: { denial_period: false },
			},
		});
		expect(matchRule(outside, ambientCtx([])).status).toBe("fired");
		expect(matchRule(outside, ambientCtx(["denial_period"]))).toEqual({
			status: "near_miss",
			reason: "Rout didn't fire: denial_period active",
			awaiting: [],
			state_mismatch: true,
		});
	});

	it("every clause must hold when several are named", () => {
		const both = rule({
			id: "Rboth",
			condition: {
				type: "orgasm",
				metadata: {},
				timer_active: { denial_period: true, session_stopwatch: false },
			},
		});
		expect(matchRule(both, ambientCtx(["denial_period"])).status).toBe("fired");
		expect(
			matchRule(both, ambientCtx(["denial_period", "session_stopwatch"]))
				.status,
		).toBe("near_miss");
	});

	it("names every unmet clause in one row rather than picking one", () => {
		// What "sole miss" scopes over: the *kind* of miss, not the count of
		// clauses. Two unmet ambient clauses have always been comma-joined into a
		// single reason, and this pins it — the behaviour predates the counter-value
		// predicate and is what licenses that clause joining the same row (ADR 0015).
		//
		// The alternative reading, suppressing each miss because another also
		// missed, would leave this rule filing nothing at all: it would fail to fire
		// and record no reason, which is the silence a near-miss exists to prevent.
		const both = rule({
			id: "Rpair",
			condition: {
				type: "orgasm",
				metadata: {},
				timer_active: { denial_period: true, session_stopwatch: true },
			},
		});
		expect(matchRule(both, ambientCtx([]))).toEqual({
			status: "near_miss",
			reason:
				"Rpair didn't fire: denial_period not active, session_stopwatch not active",
			awaiting: [],
			state_mismatch: true,
		});
	});

	it("a rule with no clause is unaffected by ambient state", () => {
		const plain = rule({
			id: "Rplain",
			condition: { type: "orgasm", metadata: {} },
		});
		expect(matchRule(plain, ambientCtx(["denial_period"])).status).toBe(
			"fired",
		);
		expect(matchRule(plain, ambientCtx([])).status).toBe("fired");
	});

	it("reports the metadata miss, not the ambient one, when both are unmet", () => {
		// The sole-miss rule: a reader can act on "permitted not set" — a ruling
		// resolves it. Reporting the denial instead would bury that.
		const result = matchRule(escalation, ambientCtx([], {}));
		expect(result).toMatchObject({
			status: "near_miss",
			reason: "R26 didn't fire: permitted not set",
			awaiting: ["permitted"],
		});
		expect(result).not.toHaveProperty("state_mismatch");
	});

	it("surfaces a sole ambient miss even under the awaiting filter", () => {
		// It earns the row precisely because everything else held: this rule would
		// have fired if the mode had been on, and the sub can see it was considered.
		const { nearMisses } = evaluateRules([escalation], {
			...ambientCtx([]),
			awaiting: ["permitted"],
		});
		expect(nearMisses.map((n) => n.rule_id)).toEqual(["R26"]);
	});

	it("keeps routine events out of the trace when the metadata missed too", () => {
		const { nearMisses } = evaluateRules([escalation], {
			...ambientCtx([], { permitted: true }),
			awaiting: ["permitted"],
		});
		// A set-but-wrong `permitted` is the existing noise case, and the ambient
		// clause must not smuggle it back in.
		expect(nearMisses).toEqual([]);
	});
});

describe("comparison clauses (ADR 0011)", () => {
	const lowMood = rule({
		id: "R27",
		condition: {
			type: "check_in",
			metadata: { mood: { op: "lte", value: 2 } },
		},
	});

	it("fires at and below the bound, not above it", () => {
		expect(matchRule(lowMood, ctx("check_in", { mood: 1 })).status).toBe(
			"fired",
		);
		expect(matchRule(lowMood, ctx("check_in", { mood: 2 })).status).toBe(
			"fired",
		);
		expect(matchRule(lowMood, ctx("check_in", { mood: 3 }))).toEqual({
			status: "near_miss",
			reason: "R27 didn't fire: mood is 3, needs <= 2",
			awaiting: [],
		});
	});

	it("covers each operator at its boundary", () => {
		const at = (op: "lt" | "lte" | "gt" | "gte", value: number, mood: number) =>
			matchRule(
				rule({
					id: "Rop",
					condition: { type: "check_in", metadata: { mood: { op, value } } },
				}),
				ctx("check_in", { mood }),
			).status;
		expect(at("lt", 3, 3)).toBe("near_miss");
		expect(at("lt", 3, 2)).toBe("fired");
		expect(at("lte", 3, 3)).toBe("fired");
		expect(at("gt", 3, 3)).toBe("near_miss");
		expect(at("gt", 3, 4)).toBe("fired");
		expect(at("gte", 3, 3)).toBe("fired");
	});

	it("an unset key still awaits, exactly as an equality would", () => {
		// The pending-adjudication case is about the key being absent, not about
		// which kind of constraint would have been applied to it.
		expect(matchRule(lowMood, ctx("check_in", {}))).toEqual({
			status: "near_miss",
			reason: "R27 didn't fire: mood not set",
			awaiting: ["mood"],
		});
	});

	it("a non-numeric value fails rather than coercing", () => {
		// Only reachable if a type's schema changed under a rule validated against
		// the old one. The rule goes quiet instead of scoring on a string.
		expect(matchRule(lowMood, ctx("check_in", { mood: "low" })).status).toBe(
			"near_miss",
		);
	});
});

/**
 * The counter-value predicate (ADR 0015). The clause mirrors `timer_active` down to the
 * resolution seam, so these mirror the ambient-state cases above — with one
 * addition the timer has no counterpart for: a counter the caller did not
 * resolve is *unknown*, and unknown is not zero.
 */
describe("the counter-value predicate (ADR 0015)", () => {
	const escalate = rule({
		id: "R30",
		condition: {
			type: "infraction",
			metadata: {},
			counter_value: { demerits: { op: "gte", value: 10 } },
		},
	});

	function scored(values: Record<string, number>): RuleEventContext {
		return {
			...ctx("infraction"),
			counter_values: new Map(Object.entries(values)),
		};
	}

	it("fires when the counter satisfies the comparison", () => {
		expect(matchRule(escalate, scored({ demerits: 10 }))).toEqual({
			status: "fired",
		});
	});

	it("near-misses with the value, and never awaits a ruling", () => {
		// No ruling on any metadata key makes the score have been 10, so promising
		// the adjudication queue a resolution would be a lie — the same reasoning
		// that keeps an ambient-state miss out of `awaiting`.
		expect(matchRule(escalate, scored({ demerits: 9 }))).toEqual({
			status: "near_miss",
			reason: "R30 didn't fire: demerits is 9, needs >= 10",
			awaiting: [],
			state_mismatch: true,
		});
	});

	it("treats a counter nobody resolved as unknown, not as zero", () => {
		// Zero would let "while demerits are under 5" fire on a counter no caller
		// read — a rule scoring on a number that was never true.
		const lenient = rule({
			id: "R31",
			condition: {
				type: "infraction",
				metadata: {},
				counter_value: { demerits: { op: "lt", value: 5 } },
			},
		});
		expect(matchRule(lenient, ctx("infraction"))).toEqual({
			status: "near_miss",
			reason: "R31 didn't fire: demerits is unknown, needs < 5",
			awaiting: [],
			state_mismatch: true,
		});
	});

	it("reports a metadata miss over a score miss", () => {
		// A state miss is only worth a row when it was the sole reason: the
		// metadata is the part a reader can act on, and the converse would file
		// "demerits is 0" against every routine event of the type.
		const both = rule({
			id: "R32",
			condition: {
				type: "infraction",
				metadata: { severity: "major" },
				counter_value: { demerits: { op: "gte", value: 10 } },
			},
		});
		expect(matchRule(both, scored({ demerits: 0 }))).toEqual({
			status: "near_miss",
			reason: "R32 didn't fire: severity not set",
			awaiting: ["severity"],
		});
	});

	it("says both things in one row when only state missed", () => {
		// The same shape two unmet *ambient* clauses have always taken (see "names
		// every unmet clause in one row"), extended to the pair. "Sole miss" is
		// about metadata-vs-state, and the metadata held here.
		const both = rule({
			id: "R33",
			condition: {
				type: "orgasm",
				metadata: {},
				timer_active: { denial_period: true },
				counter_value: { demerits: { op: "gte", value: 10 } },
			},
		});
		expect(
			matchRule(both, {
				...ctx("orgasm"),
				counter_values: new Map([["demerits", 2]]),
			}),
		).toEqual({
			status: "near_miss",
			reason:
				"R33 didn't fire: denial_period not active, demerits is 2, needs >= 10",
			awaiting: [],
			state_mismatch: true,
		});
	});

	it("reads one score for every rule on the event, whatever the order", () => {
		// The context is built once, before any effect lands, so a rule that reads
		// `demerits` and a rule that increments it cannot see each other — and the
		// answer does not depend on which is listed first.
		const reader = rule({
			id: "R-read",
			condition: {
				type: "infraction",
				metadata: {},
				counter_value: { demerits: { op: "gte", value: 10 } },
			},
			effects: [{ verb: "increment_counter", counter: "escalations", by: 1 }],
		});
		const writer = rule({
			id: "R-write",
			condition: { type: "infraction", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
		});
		const at9 = scored({ demerits: 9 });
		// The infraction that crosses 10 does not escalate itself, in either order.
		expect(
			evaluateRules([reader, writer], at9).fired.map((f) => f.rule_id),
		).toEqual(["R-write"]);
		expect(
			evaluateRules([writer, reader], at9).fired.map((f) => f.rule_id),
		).toEqual(["R-write"]);
	});
});

/** A routed magnitude (ADR 0015) — `by_from`, and what it does with nothing. */
describe("by_from — a routed magnitude", () => {
	const weighted = rule({
		id: "R34",
		condition: { type: "infraction", metadata: {} },
		effects: [
			{
				verb: "increment_counter",
				counter: "demerits",
				by: 1,
				by_from: "weight",
			},
		],
	});

	it("routes the event's number as the amount", () => {
		expect(
			evaluateRules([weighted], ctx("infraction", { weight: 3 })).fired,
		).toEqual([
			{
				rule_id: "R34",
				ops: [{ kind: "counter", counter: "demerits", op: "increment", by: 3 }],
			},
		]);
	});

	it("skips rather than falling back to `by` when the key is absent", () => {
		// Falling back would make the trace read `+1` for a rule its author
		// believed was proportional — the failure ADR 0015 declined by name.
		expect(evaluateRules([weighted], ctx("infraction")).fired).toEqual([
			{
				rule_id: "R34",
				ops: [
					{
						kind: "skipped",
						counter: "demerits",
						op: "increment",
						key: "weight",
					},
				],
			},
		]);
	});

	it("skips a fraction rather than rounding it", () => {
		// Unreachable through `validateRule`, which refuses a `by_from` on a field
		// not declared integer. Refused here anyway rather than trusted: rounding
		// would invent a number nobody wrote.
		expect(
			evaluateRules([weighted], ctx("infraction", { weight: 2.5 })).fired[0]
				?.ops,
		).toEqual([
			{ kind: "skipped", counter: "demerits", op: "increment", key: "weight" },
		]);
	});

	it("leaves an effect without `by_from` on its literal", () => {
		const plain = rule({
			id: "R35",
			condition: { type: "infraction", metadata: {} },
			effects: [{ verb: "decrement_counter", counter: "demerits", by: 2 }],
		});
		expect(evaluateRules([plain], ctx("infraction")).fired[0]?.ops).toEqual([
			{ kind: "counter", counter: "demerits", op: "decrement", by: 2 },
		]);
	});
});
