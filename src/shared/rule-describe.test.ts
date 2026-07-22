import { describe, expect, it } from "vitest";
import { STARTER_EVENT_TYPES } from "#/templates/index.ts";
import {
	describeCondition,
	describeEffect,
	describeRule,
	isPickerEditable,
} from "./rule-describe.ts";
import type { Rule } from "./rules.ts";

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
});

describe("describeEffect", () => {
	it("renders counter increments and decrements with the amount", () => {
		expect(
			describeEffect({ verb: "increment_counter", counter: "demerits", by: 2 }),
		).toBe("+2 to demerits");
		expect(
			describeEffect({ verb: "decrement_counter", counter: "demerits", by: 1 }),
		).toBe("−1 from demerits");
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
		).toBe('reset the "since last infraction" clock');
		expect(describeEffect({ verb: "notify", target: "partner" })).toBe(
			"notify your partner",
		);
	});

	it("shows a timer close's duration routing", () => {
		expect(
			describeEffect({
				verb: "close_timer",
				timer: "session_stopwatch",
				status: "completed",
				route_duration_to: "service_minutes_week",
			}),
		).toBe(
			"stop the session stopwatch timer and add its time to service minutes week",
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
			effects: ["+1 to demerits"],
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
