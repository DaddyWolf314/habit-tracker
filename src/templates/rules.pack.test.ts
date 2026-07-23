import { describe, expect, it } from "vitest";
import { evaluateRules, rulesEffectiveAt } from "#/shared/engine.ts";
import { reconcilePack } from "#/shared/rule-reconciliation.ts";
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

describe("R1–R23 default rule pack (handoff §7, ADR 0001, ADR 0003, ADR 0004)", () => {
	it("installs exactly R1 through R23", () => {
		expect(DEFAULT_RULES).toHaveLength(23);
		expect(DEFAULT_RULES.map((r) => r.id)).toEqual(
			Array.from({ length: 23 }, (_, i) => `R${i + 1}`),
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

	it("R22 opens the task countdown from a task_assigned, routing its duration (ADR 0004)", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "task_assigned",
			metadata: { task_id: "t7", duration_ms: 3_600_000 },
			occurred_at: 1000,
		});
		expect(fired.map((f) => f.rule_id)).toEqual(["R22"]);
		expect(fired[0]?.ops).toEqual([
			{
				kind: "timer",
				timer: "task_countdown",
				op: "open",
				match_on: { task_id: "t7" },
				tag: undefined,
				duration_ms: 3_600_000,
			},
		]);
	});

	it("R4 closes by task_id exactly what R22 opened (assign→complete pairing, ADR 0004)", () => {
		const assigned = evaluateRules(DEFAULT_RULES, {
			type: "task_assigned",
			metadata: { task_id: "t7", duration_ms: 60_000 },
			occurred_at: 1,
		});
		const completed = evaluateRules(DEFAULT_RULES, {
			type: "task_completed",
			metadata: { task_id: "t7" },
			occurred_at: 2,
		});
		const openMatch = assigned.fired[0]?.ops.find(
			(op) => op.kind === "timer" && op.op === "open",
		);
		const closeOp = completed.fired
			.flatMap((f) => f.ops)
			.find((op) => op.kind === "timer" && op.op === "close");
		// The close matches on the same resolved ref the open pinned.
		expect(closeOp).toMatchObject({
			timer: "task_countdown",
			op: "close",
			match_on: { task_id: "t7" },
			status: "completed",
		});
		expect(openMatch).toMatchObject({ match_on: { task_id: "t7" } });
	});

	it("R23 opens the denial period from a denial_started, routing its duration (ADR 0004)", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "denial_started",
			metadata: { duration_ms: 86_400_000 },
			occurred_at: 500,
		});
		expect(fired.map((f) => f.rule_id)).toEqual(["R23"]);
		expect(fired[0]?.ops).toEqual([
			{
				kind: "timer",
				timer: "denial_period",
				op: "open",
				match_on: undefined,
				tag: undefined,
				duration_ms: 86_400_000,
			},
		]);
	});

	it("an unpermitted sub orgasm fans out across R10/R12/R14 (max fan-out)", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "orgasm",
			metadata: { permitted: false, outcome: "full" },
			occurred_at: 1,
			subject_role: "sub",
		});
		expect(fired.map((f) => f.rule_id).sort()).toEqual(["R10", "R12", "R14"]);
	});

	it("a dom-subject orgasm fires only R21 — no sub counters, no demerits, no queue (ADR 0003)", () => {
		const { fired, nearMisses } = evaluateRules(DEFAULT_RULES, {
			type: "orgasm",
			// `permitted` deliberately unset AND outcome full: were the sub rules in
			// play this would be the max-fan-out shape. None of it may fire.
			metadata: { outcome: "full" },
			occurred_at: 1,
			subject_role: "dom",
		});
		expect(fired.map((f) => f.rule_id)).toEqual(["R21"]);
		expect(fired[0]?.ops).toEqual([
			{ kind: "anchor", anchor: "since_dom_last_orgasm", at: 1 },
			{
				kind: "counter",
				counter: "dom_orgasms_lifetime",
				op: "increment",
				by: 1,
			},
		]);
		// The sub-qualified family is dormant, and legibly so: each records a
		// subject near-miss in the trace ("why didn't the sub's rules fire").
		expect(nearMisses.map((n) => n.rule_id).sort()).toEqual([
			"R10",
			"R11",
			"R12",
			"R13",
			"R14",
		]);
		for (const miss of nearMisses) {
			expect(miss.reason).toContain("subject is not the sub");
		}
	});

	it("a sub orgasm leaves R21 dormant (near-miss), feeding no dom projections", () => {
		const { fired, nearMisses } = evaluateRules(DEFAULT_RULES, {
			type: "orgasm",
			metadata: { permitted: true, outcome: "full" },
			occurred_at: 1,
			subject_role: "sub",
		});
		expect(fired.map((f) => f.rule_id)).not.toContain("R21");
		expect(nearMisses.map((n) => n.rule_id)).toContain("R21");
	});

	it("in a switch/switch couple every orgasm pack rule is dormant by design", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "orgasm",
			metadata: { permitted: false, outcome: "full" },
			occurred_at: 1,
			subject_role: "switch",
		});
		expect(fired).toEqual([]);
	});

	it("replay determinism across the bump: old events keep the unqualified versions (ADR 0002 + 0003)", () => {
		// A couple seeded on the pre-qualifier pack: drop R21 (which didn't exist)
		// and strip subject_role to reconstruct the v3 definitions, installed at 0.
		const BUMP_AT = 1_000;
		const oldPack = DEFAULT_RULES.filter((r) => r.id !== "R21").map((r) => ({
			...r,
			condition: { type: r.condition.type, metadata: r.condition.metadata },
		}));
		const installed = reconcilePack(oldPack, [], 0).added;
		const bump = reconcilePack(DEFAULT_RULES, installed, BUMP_AT);
		// R21 is brand-new; the qualified R10–R14 are forward-only upserts.
		expect(bump.added.map((r) => r.id)).toEqual(["R21"]);
		expect(bump.upserted.map((u) => u.id).sort()).toEqual(
			["R10", "R11", "R12", "R13", "R14"].sort(),
		);
		const history = [
			...installed.map((rule) =>
				rule.id === "R21"
					? rule
					: {
							...rule,
							versions: [
								...rule.versions,
								...bump.upserted
									.filter((u) => u.id === rule.id)
									.map((u) => u.version),
							],
						},
			),
			...bump.added,
		];
		const domOrgasm = {
			type: "orgasm",
			metadata: {},
			occurred_at: 1,
			subject_role: "dom" as const,
		};
		// Logged before the bump: the unqualified R10 was in force — it fired on
		// what we now know was the dom's orgasm. Replay reproduces that history.
		const before = evaluateRules(
			rulesEffectiveAt(history, BUMP_AT - 1),
			domOrgasm,
		);
		expect(before.fired.map((f) => f.rule_id)).toContain("R10");
		expect(before.fired.map((f) => f.rule_id)).not.toContain("R21");
		// Logged at/after the bump: the qualified versions govern — only R21 fires.
		const after = evaluateRules(rulesEffectiveAt(history, BUMP_AT), domOrgasm);
		expect(after.fired.map((f) => f.rule_id)).toEqual(["R21"]);
	});

	it("R19 opens a journal_countdown on a journal_prompt, tagged with the floor", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "journal_prompt",
			metadata: { prompt_id: "p1", floor: "shared" },
			occurred_at: 1,
		});
		expect(fired.map((f) => f.rule_id)).toEqual(["R19"]);
		const op = fired[0]?.ops[0];
		expect(op).toMatchObject({
			kind: "timer",
			timer: "journal_countdown",
			op: "open",
			match_on: { prompt_id: "p1" },
			tag: "shared",
		});
	});

	it("R20's answering journal_entry closes the countdown by prompt_id match", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "journal_entry",
			metadata: { prompt_id: "p1" },
			occurred_at: 1,
		});
		expect(fired.map((f) => f.rule_id)).toEqual(["R20"]);
		expect(fired[0]?.ops[0]).toMatchObject({
			kind: "timer",
			timer: "journal_countdown",
			op: "close",
			match_on: { prompt_id: "p1" },
			status: "completed",
		});
	});
});
