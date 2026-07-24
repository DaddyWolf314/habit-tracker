import { describe, expect, it } from "vitest";
import {
	DEFAULT_ANCHORS,
	DEFAULT_COUNTERS,
	DEFAULT_RULES,
	DEFAULT_TIMERS,
	STARTER_EVENT_TYPES,
} from "#/templates/index.ts";
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
