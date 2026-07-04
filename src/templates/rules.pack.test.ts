import { describe, expect, it } from "vitest";
import { evaluateRules } from "#/shared/engine.ts";
import {
	DEFAULT_ANCHORS,
	DEFAULT_COUNTERS,
	DEFAULT_RULES,
	DEFAULT_TIMERS,
	STARTER_EVENT_TYPES,
} from "./index.ts";

const starterIds = new Set(STARTER_EVENT_TYPES.map((t) => t.id));
const counterIds = new Set(DEFAULT_COUNTERS.map((c) => c.id));
const anchors = new Set(DEFAULT_ANCHORS);
const timers = new Set(DEFAULT_TIMERS);

describe("R1–R18 default rule pack (handoff §7)", () => {
	it("installs exactly R1 through R18", () => {
		expect(DEFAULT_RULES).toHaveLength(18);
		expect(DEFAULT_RULES.map((r) => r.id)).toEqual(
			Array.from({ length: 18 }, (_, i) => `R${i + 1}`),
		);
	});

	it("every projection derives from only the starter seven", () => {
		for (const rule of DEFAULT_RULES) {
			// Condition types are starter-seven event types.
			expect(starterIds.has(rule.condition.type)).toBe(true);
			for (const effect of rule.effects) {
				switch (effect.verb) {
					case "increment_counter":
					case "decrement_counter":
					case "reset_counter":
						expect(counterIds.has(effect.counter)).toBe(true);
						break;
					case "reset_anchor":
						expect(anchors.has(effect.anchor)).toBe(true);
						break;
					case "open_timer":
					case "close_timer":
						expect(timers.has(effect.timer)).toBe(true);
						if (effect.verb === "close_timer" && effect.route_duration_to) {
							expect(counterIds.has(effect.route_duration_to)).toBe(true);
						}
						break;
					case "notify":
						expect(effect.target).toBe("partner");
						break;
				}
			}
		}
	});

	it("preserves the honesty-incentive gap: minor + self-reported adds no demerits", () => {
		// The gap is expressed purely by rule absence — R9 requires self_reported=false.
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "infraction",
			metadata: { severity: "minor", self_reported: true },
			occurred_at: 1,
		});
		const demeritEffects = fired.flatMap((f) =>
			f.ops.filter((op) => op.kind === "counter" && op.counter === "demerits"),
		);
		expect(demeritEffects).toEqual([]);
		// Sanity: R6 (infractions_lifetime) and R7 (anchor reset) still fire.
		expect(fired.map((f) => f.rule_id).sort()).toEqual(["R6", "R7"]);
	});

	it("a confessed major infraction still adds demerits (gap is minor-only)", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "infraction",
			metadata: { severity: "major", self_reported: true },
			occurred_at: 1,
		});
		expect(fired.map((f) => f.rule_id)).toContain("R8");
	});

	it("`note` fires no rules — silence is allowed by design", () => {
		const { fired, nearMisses } = evaluateRules(DEFAULT_RULES, {
			type: "note",
			metadata: {},
			occurred_at: 1,
		});
		expect(fired).toEqual([]);
		expect(nearMisses).toEqual([]);
	});

	it("an unpermitted orgasm fans out across R10/R12/R14 (max fan-out)", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "orgasm",
			metadata: { permitted: false, outcome: "full" },
			occurred_at: 1,
		});
		expect(fired.map((f) => f.rule_id).sort()).toEqual(["R10", "R12", "R14"]);
	});
});
