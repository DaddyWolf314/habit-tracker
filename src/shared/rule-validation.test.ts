import { describe, expect, it } from "vitest";
import {
	DEFAULT_ANCHORS,
	DEFAULT_COUNTERS,
	DEFAULT_RULES,
	DEFAULT_TIMERS,
	STARTER_EVENT_TYPES,
} from "#/templates/index.ts";
import { eventTypeSchema } from "./event-types.ts";
import {
	type RuleValidationContext,
	validateRule,
	validateRuleVersion,
} from "./rule-validation.ts";
import { type Rule, type RuleVersion, ruleSchema } from "./rules.ts";

const ctx: RuleValidationContext = {
	eventTypes: new Map(STARTER_EVENT_TYPES.map((t) => [t.id, t])),
	counters: new Set(DEFAULT_COUNTERS.map((c) => c.id)),
	anchors: new Set(DEFAULT_ANCHORS),
	timers: new Set(DEFAULT_TIMERS),
};

function rule(partial: Partial<Rule> & Pick<Rule, "id" | "condition">): Rule {
	return {
		effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
		enabled: true,
		...partial,
	};
}

describe("rule creation-time validation (handoff §4.3)", () => {
	it("accepts every default rule against the default context", () => {
		for (const r of DEFAULT_RULES) {
			expect(validateRule(r, ctx)).toEqual({ ok: true });
		}
	});

	it("rejects a condition on an unknown event type", () => {
		const r = rule({ id: "X", condition: { type: "nope", metadata: {} } });
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("unknown event type");
	});

	it("rejects a condition on a key the type does not define", () => {
		// orgasm has no `wombat` key — this would silently skip forever at runtime.
		const r = rule({
			id: "X",
			condition: { type: "orgasm", metadata: { wombat: true } },
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("wombat");
	});

	it("accepts a subject-role qualifier on any type (ADR 0003)", () => {
		// Every event may carry a subject regardless of `subject_required`, and a
		// qualifier matching no member (dom in a switch/switch couple) is dormant
		// by design — roles are couple state, not schema — so this never rejects.
		for (const subjectRole of ["dom", "sub", "switch"] as const) {
			const r = rule({
				id: "X",
				condition: {
					type: "check_in",
					subject_role: subjectRole,
					metadata: {},
				},
			});
			expect(validateRule(r, ctx)).toEqual({ ok: true });
		}
	});

	it("rejects a subject clause outside the role enum at the schema layer", () => {
		// Parallel to the fractional-`by` case: createRule parses before validating,
		// so a made-up role never reaches validateRule.
		const parsed = ruleSchema.safeParse({
			id: "X",
			condition: { type: "orgasm", subject_role: "butler", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
			enabled: true,
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a condition value outside an enum's options", () => {
		const r = rule({
			id: "X",
			condition: { type: "infraction", metadata: { severity: "critical" } },
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("severity");
	});

	it("rejects an effect targeting an unknown counter", () => {
		const r = rule({
			id: "X",
			condition: { type: "orgasm", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "ghost", by: 1 }],
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("ghost");
	});

	it("rejects an effect resetting an unknown anchor", () => {
		const r = rule({
			id: "X",
			condition: { type: "infraction", metadata: {} },
			effects: [{ verb: "reset_anchor", anchor: "since_last_nothing" }],
		});
		expect(validateRule(r, ctx).ok).toBe(false);
	});

	it("rejects a timer close routing duration into an unknown counter", () => {
		const r = rule({
			id: "X",
			condition: { type: "session_ended", metadata: {} },
			effects: [
				{
					verb: "close_timer",
					timer: "session_stopwatch",
					status: "completed",
					route_duration_to: "phantom_counter",
				},
			],
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("phantom_counter");
	});

	it("rejects an open_timer routing duration from a key the type does not define", () => {
		// Typo'd `duration_from` would silently open a never-expiring stopwatch
		// instead of a countdown — exactly the invisible-at-runtime failure this
		// module exists to catch at creation.
		const r = rule({
			id: "X",
			condition: { type: "task_assigned", metadata: {} },
			effects: [
				{
					verb: "open_timer",
					timer: "task_countdown",
					duration_from: "durationms",
				},
			],
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("durationms");
	});

	it("rejects an open_timer routing duration from a non-number field", () => {
		const r = rule({
			id: "X",
			condition: { type: "task_assigned", metadata: {} },
			effects: [
				{
					verb: "open_timer",
					timer: "task_countdown",
					duration_from: "task_id", // a ref, not a number
				},
			],
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("task_id");
	});

	it("accepts an open_timer tagging from a text field (ADR 0005)", () => {
		// R22's shape after minting: the id matched on is opaque, so the timer's
		// human label rides `tag_from` off the dom's typed `task_name`.
		const r = rule({
			id: "X",
			condition: { type: "task_assigned", metadata: {} },
			effects: [
				{
					verb: "open_timer",
					timer: "task_countdown",
					match_on: { task_id: "task_id" },
					tag_from: "task_name",
					duration_from: "duration_ms",
				},
			],
		});
		expect(validateRule(r, ctx)).toEqual({ ok: true });
	});

	it("rejects a match_on ref pointing at a key the type does not define", () => {
		// A typo'd event key makes every close resolve an incomplete match and
		// orphan — no session would ever close, with no error anywhere.
		const r = rule({
			id: "X",
			condition: { type: "session_ended", metadata: {} },
			effects: [
				{
					verb: "close_timer",
					timer: "session_stopwatch",
					match_on: { session_id: "sessionid" },
					status: "completed",
				},
			],
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("sessionid");
	});

	it("rejects a route_when gate on a key the type does not define", () => {
		const r = rule({
			id: "X",
			condition: { type: "session_ended", metadata: {} },
			effects: [
				{
					verb: "close_timer",
					timer: "session_stopwatch",
					status: "completed",
					route_duration_to: "service_minutes_week",
					route_when: { activty: "service" },
				},
			],
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("activty");
	});

	it("rejects a fractional counter `by` at the schema layer (createRule parses first)", () => {
		const parsed = ruleSchema.safeParse({
			id: "X",
			condition: { type: "orgasm", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "demerits", by: 0.5 }],
		});
		expect(parsed.success).toBe(false);
	});

	it("accepts a valid custom rule that installs cleanly", () => {
		const r = rule({
			id: "custom-1",
			condition: { type: "check_in", metadata: { flag: "wants_conversation" } },
			effects: [
				{ verb: "increment_counter", counter: "check_ins_week", by: 1 },
			],
		});
		expect(validateRule(r, ctx)).toEqual({ ok: true });
	});
});

/** A proposed rule version for the edit path, with a throwaway effective_from. */
function version(
	partial: Partial<RuleVersion> & Pick<RuleVersion, "condition">,
): RuleVersion {
	return {
		effective_from: 1_000,
		effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
		enabled: true,
		...partial,
	};
}

describe("edit-path validation (ADR 0002) — identical to a create", () => {
	it("accepts a valid edit — a re-pointed default rule still validates", () => {
		// Edit R2 (late ritual) to cost +2 demerits instead of +1: valid, like a create.
		const v = version({
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [{ verb: "increment_counter", counter: "demerits", by: 2 }],
		});
		expect(validateRuleVersion("R2", v, ctx)).toEqual({ ok: true });
	});

	it("rejects an edit conditioning on an unknown key, with a clear error", () => {
		const v = version({
			condition: { type: "orgasm", metadata: { wombat: true } },
		});
		const result = validateRuleVersion("R11", v, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("wombat");
	});

	it("rejects an edit targeting an unknown projection, with a clear error", () => {
		const v = version({
			condition: { type: "orgasm", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "ghost", by: 1 }],
		});
		const result = validateRuleVersion("R11", v, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("ghost");
	});

	it("is exactly validateRule on the flattened version — effective_from is irrelevant", () => {
		const condition = { type: "check_in" as const, metadata: {} };
		const effects = [
			{ verb: "increment_counter" as const, counter: "check_ins_week", by: 1 },
		];
		const early = validateRuleVersion(
			"custom-1",
			version({ condition, effects, effective_from: 0 }),
			ctx,
		);
		const late = validateRuleVersion(
			"custom-1",
			version({ condition, effects, effective_from: 9_999_999 }),
			ctx,
		);
		const asCreate = validateRule(
			rule({ id: "custom-1", condition, effects }),
			ctx,
		);
		expect(early).toEqual(asCreate);
		expect(late).toEqual(asCreate);
		expect(asCreate).toEqual({ ok: true });
	});
});

describe("ambient-state and comparison clauses (ADR 0011)", () => {
	it("accepts a timer_active clause naming a known definition", () => {
		const r = rule({
			id: "X",
			condition: {
				type: "orgasm",
				metadata: {},
				timer_active: { denial_period: true },
			},
		});
		expect(validateRule(r, ctx)).toEqual({ ok: true });
	});

	it("rejects a timer_active clause naming an unknown definition", () => {
		// A typo'd definition reads as "never active" at runtime and holds the rule
		// shut for ever — the same invisible failure an unknown metadata key causes.
		const r = rule({
			id: "X",
			condition: {
				type: "orgasm",
				metadata: {},
				timer_active: { denail_period: true },
			},
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("denail_period");
	});

	it("accepts a comparison on a number field", () => {
		const r = rule({
			id: "X",
			condition: {
				type: "check_in",
				metadata: { mood: { op: "lte", value: 2 } },
			},
			effects: [{ verb: "notify", target: "partner" }],
		});
		expect(validateRule(r, ctx)).toEqual({ ok: true });
	});

	it("refuses a comparison on a non-number field", () => {
		// `severity > "major"` has no answer; refused at creation rather than never
		// matching for the rest of the couple's life.
		const r = rule({
			id: "X",
			condition: {
				type: "infraction",
				metadata: { severity: { op: "gt", value: 2 } },
			},
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("only numbers can be compared");
	});

	it("still refuses a comparison on a key the type does not have", () => {
		const r = rule({
			id: "X",
			condition: {
				type: "check_in",
				metadata: { moood: { op: "lte", value: 2 } },
			},
			effects: [{ verb: "notify", target: "partner" }],
		});
		const result = validateRule(r, ctx);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("unknown key 'moood'");
	});
});

/** The counter-value predicate and the routed magnitude (ADR 0015). */
describe("counter_value and by_from", () => {
	function failure(r: Rule): string {
		const result = validateRule(r, ctx);
		if (result.ok) throw new Error("expected a validation failure");
		return result.error;
	}

	it("accepts a score clause on a known counter", () => {
		const r = rule({
			id: "X",
			condition: {
				type: "infraction",
				metadata: {},
				counter_value: { demerits: { op: "gte", value: 10 } },
			},
		});
		expect(validateRule(r, ctx)).toEqual({ ok: true });
	});

	it("refuses a score clause naming a counter that does not exist", () => {
		// An unknown counter never resolves to a value, so the clause would read as
		// permanently unmet and hold the rule shut for ever, invisibly — the same
		// failure an unknown timer or metadata key would cause.
		const r = rule({
			id: "X",
			condition: {
				type: "infraction",
				metadata: {},
				counter_value: { demeritz: { op: "gte", value: 10 } },
			},
		});
		expect(failure(r)).toContain("unknown counter 'demeritz'");
	});

	it("accepts a by_from naming a field declared integer", () => {
		// `mood` is a 1–5 scale and the pack declares it whole.
		const r = rule({
			id: "X",
			condition: { type: "check_in", metadata: {} },
			effects: [
				{
					verb: "increment_counter",
					counter: "demerits",
					by: 1,
					by_from: "mood",
				},
			],
		});
		expect(validateRule(r, ctx)).toEqual({ ok: true });
	});

	/**
	 * A context carrying one extra type, `weighed`, whose single `kilograms`
	 * field is declared however a case needs. The pack's own number fields are all
	 * whole and floored at 1, so the ways a routed magnitude can be refused are
	 * only reachable through a field a couple authored.
	 */
	function ctxWithKilograms(
		declared: Record<string, unknown>,
	): RuleValidationContext {
		const weighed = eventTypeSchema.parse({
			id: "weighed",
			label: "Weighed",
			icon: "scale",
			valence: "neutral",
			log_permission: ["dom", "sub", "switch"],
			subject_required: false,
			metadata: {
				kilograms: {
					kind: "number",
					label: "Kilograms",
					set_permission: ["dom", "sub", "switch"],
					...declared,
				},
			},
			awaiting: [],
		});
		return {
			...ctx,
			eventTypes: new Map([...ctx.eventTypes, [weighed.id, weighed]]),
		};
	}

	/** A rule routing `kilograms` into `demerits` — the shape all three cases take. */
	const routesKilograms = rule({
		id: "X",
		condition: { type: "weighed", metadata: {} },
		effects: [
			{
				verb: "increment_counter",
				counter: "demerits",
				by: 1,
				by_from: "kilograms",
			},
		],
	});

	function failureIn(where: RuleValidationContext): string {
		const result = validateRule(routesKilograms, where);
		if (result.ok) throw new Error("expected a validation failure");
		return result.error;
	}

	it("refuses a by_from on a number field not declared integer", () => {
		// The whole point of the flag: without it, `by_from` could route 2.5 into
		// an integer counter and nothing could see it coming. Refused at creation,
		// beside the other routed-key errors — never at runtime.
		expect(failureIn(ctxWithKilograms({ min: 0 }))).toContain(
			"must be declared integer",
		);
	});

	it("refuses a by_from on a field that never declared a floor", () => {
		// A magnitude is an amount, not a direction. Without a declared `min`,
		// nothing stops `kilograms: -3` reaching an `increment_counter` and making
		// it subtract — the verb and the counter would disagree, and the trace
		// would read `+-3 demerits`.
		expect(failureIn(ctxWithKilograms({ integer: true }))).toContain(
			"must declare min 0 or higher",
		);
	});

	it("refuses a by_from on a field whose floor is below zero", () => {
		// A declared floor is only worth anything if it is at or above zero:
		// `min: -10` permits exactly the inversion the check exists to refuse.
		expect(failureIn(ctxWithKilograms({ integer: true, min: -10 }))).toContain(
			"must declare min 0 or higher",
		);
	});

	it("accepts a by_from on a field declared whole and floored at zero", () => {
		// `min: 0` is enough — `checkMetadataValue` already enforces the bound on
		// both write paths, so the negative can never be logged or amended in.
		expect(
			validateRule(
				routesKilograms,
				ctxWithKilograms({ integer: true, min: 0 }),
			),
		).toEqual({ ok: true });
	});

	it("refuses a by_from on a non-number field", () => {
		const r = rule({
			id: "X",
			condition: { type: "infraction", metadata: {} },
			effects: [
				{
					verb: "decrement_counter",
					counter: "demerits",
					by: 1,
					by_from: "severity",
				},
			],
		});
		expect(failure(r)).toContain("must be a number field");
	});

	it("refuses a by_from naming a key the type does not have", () => {
		const r = rule({
			id: "X",
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
		expect(failure(r)).toContain("unknown key 'weight'");
	});
});
