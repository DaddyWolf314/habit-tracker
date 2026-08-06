import { describe, expect, it } from "vitest";
import { STARTER_EVENT_TYPES } from "#/templates/index.ts";
import {
	describeCondition,
	describeEffect,
	describeRule,
	isPickerEditable,
} from "./rule-describe.ts";
import type { Rule } from "./rules.ts";
import { phraseCounter, summarizeEffectOp } from "./trace.ts";

const types = new Map(STARTER_EVENT_TYPES.map((t) => [t.id, t]));

describe("describeCondition", () => {
	it("renders type alone with no metadata", () => {
		expect(
			describeCondition(
				{ type: "ritual_completed", metadata: {} },
				types.get("ritual_completed"),
			),
		).toBe("when Ritual completed is logged");
	});

	it("renders a boolean equality using the field label", () => {
		expect(
			describeCondition(
				{ type: "ritual_completed", metadata: { late: true } },
				types.get("ritual_completed"),
			),
		).toBe("when Ritual completed is logged and Late? is yes");
	});

	it("joins multiple equalities with 'and'", () => {
		expect(
			describeCondition(
				{
					type: "infraction",
					metadata: { severity: "major", self_reported: false },
				},
				types.get("infraction"),
			),
		).toContain(" and ");
	});

	it("humanizes ids when no schema is supplied", () => {
		expect(
			describeCondition({
				type: "custom_thing",
				metadata: { my_key: "some_val" },
			}),
		).toBe("when custom thing is logged and my key is some val");
	});

	it("renders the subject-role qualifier as 'about the <role>' (ADR 0003)", () => {
		expect(
			describeCondition(
				{ type: "orgasm", subject_role: "dom", metadata: {} },
				types.get("orgasm"),
			),
		).toBe("when Orgasm is logged about the dom");
	});

	it("places the qualifier before metadata clauses", () => {
		expect(
			describeCondition(
				{ type: "orgasm", subject_role: "sub", metadata: { permitted: false } },
				types.get("orgasm"),
			),
		).toBe("when Orgasm is logged about the sub and Permitted? is no");
	});
});

describe("describeEffect — the shared effect phrasing (CONTEXT.md, Trace)", () => {
	it("renders counter increments and decrements with the amount", () => {
		expect(
			describeEffect({ verb: "increment_counter", counter: "demerits", by: 2 }),
		).toBe("+2 demerits");
		expect(
			describeEffect({ verb: "decrement_counter", counter: "demerits", by: 1 }),
		).toBe("−1 demerits");
	});

	it("renders resets, anchors, timers, and notify", () => {
		expect(
			describeEffect({
				verb: "reset_counter",
				counter: "rituals_completed_today",
			}),
		).toBe("reset rituals completed today");
		expect(
			describeEffect({ verb: "reset_anchor", anchor: "since_last_infraction" }),
		).toBe("reset since last infraction streak");
		expect(describeEffect({ verb: "notify", target: "partner" })).toBe(
			"notify partner",
		);
	});

	it("phrases an effect exactly as the confirm/trace surfaces phrase it firing", () => {
		// The one-phrasing rule (CONTEXT.md, Trace): "what will fire", "what
		// fired", and the rules screen must read identically.
		expect(
			describeEffect({ verb: "increment_counter", counter: "demerits", by: 2 }),
		).toBe(phraseCounter("demerits", "increment", 2));
		expect(
			describeEffect({ verb: "reset_anchor", anchor: "since_last_infraction" }),
		).toBe(
			summarizeEffectOp({
				kind: "anchor",
				anchor: "since_last_infraction",
				at: 0,
			}),
		);
	});

	it("appends a timer close's duration routing to the shared phrase", () => {
		expect(
			describeEffect({
				verb: "close_timer",
				timer: "session_stopwatch",
				status: "completed",
				route_duration_to: "service_minutes_week",
			}),
		).toBe(
			"mark session stopwatch completed and add its time to service minutes week",
		);
	});
});

describe("describeRule", () => {
	it("produces a condition sentence plus effect phrases", () => {
		const rule: Rule = {
			id: "R2",
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
			enabled: true,
		};
		expect(describeRule(rule, types.get("ritual_completed"))).toEqual({
			when: "when Ritual completed is logged and Late? is yes",
			effects: ["+1 demerits"],
		});
	});
});

describe("isPickerEditable — timer rules are advanced/read-only (#64)", () => {
	it("is true for counter/anchor/notify rules", () => {
		const rule: Rule = {
			id: "R2",
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [
				{ verb: "increment_counter", counter: "demerits", by: 1 },
				{ verb: "notify", target: "partner" },
			],
			enabled: true,
		};
		expect(isPickerEditable(rule)).toBe(true);
	});

	it("is false when any effect wires a timer", () => {
		const rule: Rule = {
			id: "R4",
			condition: { type: "task_completed", metadata: {} },
			effects: [
				{ verb: "close_timer", timer: "task_countdown", status: "completed" },
			],
			enabled: true,
		};
		expect(isPickerEditable(rule)).toBe(false);
	});
});

describe("ambient-state and comparison clauses (ADR 0011)", () => {
	it("renders a comparison in the couple's voice, not symbols", () => {
		expect(
			describeCondition(
				{ type: "check_in", metadata: { mood: { op: "lte", value: 2 } } },
				types.get("check_in"),
			),
		).toContain("2 or less");
	});

	it("phrases each operator as words", () => {
		const said = (op: "lt" | "lte" | "gt" | "gte") =>
			describeCondition({
				type: "check_in",
				metadata: { mood: { op, value: 3 } },
			});
		expect(said("lt")).toContain("under 3");
		expect(said("lte")).toContain("3 or less");
		expect(said("gt")).toContain("over 3");
		expect(said("gte")).toContain("3 or more");
	});

	it("renders the ambient clause as a trailing 'while'", () => {
		expect(
			describeCondition({
				type: "orgasm",
				metadata: { permitted: false },
				timer_active: { denial_period: true },
			}),
		).toBe(
			"when orgasm is logged and permitted is no, while a denial period is running",
		);
	});

	it("renders a negated clause as 'no … is running'", () => {
		expect(
			describeCondition({
				type: "orgasm",
				metadata: {},
				timer_active: { session_stopwatch: false },
			}),
		).toBe("when orgasm is logged, while no session stopwatch is running");
	});

	it("says nothing about ambient state when the clause is absent", () => {
		expect(describeCondition({ type: "orgasm", metadata: {} })).not.toContain(
			"while",
		);
	});
});

/**
 * The counter-value predicate in the couple's voice (ADR 0015). The confirm sheet and
 * the chain view share this phrasing, so the words here are the words a sub
 * reads when a rule fires on the strength of their score.
 */
describe("describeCondition — counter_value", () => {
	it("renders a score clause as a trailing 'while' clause", () => {
		expect(
			describeCondition({
				type: "infraction",
				metadata: {},
				counter_value: { demerits: { op: "gte", value: 10 } },
			}),
		).toBe("when infraction is logged, while demerits are 10 or more");
	});

	it("shares the trailing clause with the ambient predicate", () => {
		// One "while", not two: both constrain the moment, and the language makes
		// no distinction between them for a reader to have explained.
		expect(
			describeCondition({
				type: "orgasm",
				metadata: {},
				timer_active: { denial_period: true },
				counter_value: { demerits: { op: "gte", value: 10 } },
			}),
		).toBe(
			"when orgasm is logged, while a denial period is running and demerits are 10 or more",
		);
	});

	it("uses the same operator vocabulary the editor offers", () => {
		expect(
			describeCondition({
				type: "check_in",
				metadata: {},
				counter_value: { rituals_completed_today: { op: "lt", value: 1 } },
			}),
		).toContain("while rituals completed today are under 1");
	});
});

/** A routed magnitude, described without an event to route from (ADR 0015). */
describe("describeEffect — by_from", () => {
	it("names the key rather than resolving it to a skip", () => {
		// `resolveEffect` against an empty context resolves a `by_from` to a skip,
		// which is the truth about that context and a lie about the rule. A rules
		// screen that read "demerits unchanged" for a proportional rule would be
		// describing the describer, not the rule.
		expect(
			describeEffect(
				{
					verb: "increment_counter",
					counter: "demerits",
					by: 1,
					by_from: "mood",
				},
				types.get("check_in"),
			),
		).toBe("add Mood (1–5) to demerits");
	});

	it("de-slugs the key when there is no type to label it", () => {
		expect(
			describeEffect({
				verb: "decrement_counter",
				counter: "demerits",
				by: 1,
				by_from: "severity_weight",
			}),
		).toBe("subtract severity weight from demerits");
	});

	it("leaves a literal `by` on the shared phrase", () => {
		expect(
			describeEffect({ verb: "increment_counter", counter: "demerits", by: 2 }),
		).toBe(phraseCounter("demerits", "increment", 2));
	});
});
