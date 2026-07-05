import { describe, expect, it } from "vitest";
import {
	DEFAULT_ANCHORS,
	DEFAULT_COUNTERS,
	DEFAULT_RULES,
	DEFAULT_TIMERS,
	STARTER_EVENT_TYPES,
} from "#/templates/index.ts";
import { type RuleValidationContext, validateRule } from "./rule-validation.ts";
import { type Rule, ruleSchema } from "./rules.ts";

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
