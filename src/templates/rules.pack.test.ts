import { describe, expect, it } from "vitest";
import { agreementRefKeys } from "#/shared/agreements.ts";
import {
	evaluateRules,
	NO_COUNTER_VALUES,
	rulesEffectiveAt,
} from "#/shared/engine.ts";
import type { MetadataField } from "#/shared/event-types.ts";
import { awaitingKeysFor, vocabularySites } from "#/shared/event-types.ts";
import { isCitingRef, isOriginatingRef } from "#/shared/refs.ts";
import { reconcilePack } from "#/shared/rule-reconciliation.ts";
import { matchStopwatch, type OpenStopwatch } from "#/shared/timers.ts";
import {
	DEFAULT_AGREEMENT_KINDS,
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

describe("R1–R28 default rule pack (handoff §7, ADR 0001, ADR 0003, ADR 0004, ADR 0011, ADR 0017)", () => {
	it("installs exactly R1 through R28", () => {
		expect(DEFAULT_RULES).toHaveLength(28);
		expect(DEFAULT_RULES.map((r) => r.id)).toEqual(
			Array.from({ length: 28 }, (_, i) => `R${i + 1}`),
		);
	});

	// The pack names every rule it ships (#150). Pinned, because the v11 migration
	// deliberately leaves pack rows null and defers to `rules.json` — a rule the
	// pack forgot to name would render as "R7" for ever, with nothing to catch it.
	// It is also the couple's only route to a name for a rule they never edited.
	it("names every rule, distinctly", () => {
		const names = DEFAULT_RULES.map((r) => r.name);
		for (const name of names) {
			expect(name?.trim()).toBeTruthy();
		}
		// Two rules called the same thing is a rules screen that cannot be read.
		expect(new Set(names).size).toBe(DEFAULT_RULES.length);
	});

	it("every projection derives from only the starter seven", () => {
		for (const rule of DEFAULT_RULES) {
			// Condition types are starter-seven event types.
			expect(starterIds.has(rule.condition.type)).toBe(true);
			for (const effect of rule.effects) {
				switch (effect.verb) {
					case "increment_counter":
					case "decrement_counter":
						// A **routed target** (ADR 0017) names no counter here by design:
						// the redemption rule moves whichever currency the item was priced
						// in, and the couple's own counters are not the pack's to know. It
						// still has to route off a real key on the triggering type, which
						// `validateRule` checks and the pack-validity test below exercises.
						if (effect.counter_from !== undefined) {
							expect(effect.counter).toBeUndefined();
							break;
						}
						expect(counterIds.has(effect.counter ?? "")).toBe(true);
						break;
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
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
			subject_role: "sub",
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
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
			subject_role: "sub",
		});
		expect(fired.map((f) => f.rule_id)).toContain("R8");
	});

	it("`note` fires no rules — silence is allowed by design", () => {
		const { fired, nearMisses } = evaluateRules(DEFAULT_RULES, {
			type: "note",
			metadata: {},
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
		});
		expect(fired).toEqual([]);
		expect(nearMisses).toEqual([]);
	});

	it("R22 opens the task countdown from a task_assigned, routing its duration (ADR 0004)", () => {
		// The id is minted and opaque (ADR 0005), so the row's readable label rides
		// `tag_from` off the dom's typed `task_name` — exactly as a stopwatch's tag
		// rides `activity`.
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "task_assigned",
			metadata: {
				task_id: "01JB6X000000000000000000T7",
				task_name: "dishes",
				duration_ms: 3_600_000,
			},
			occurred_at: 1000,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
		});
		expect(fired.map((f) => f.rule_id)).toEqual(["R22"]);
		expect(fired[0]?.ops).toEqual([
			{
				kind: "timer",
				timer: "task_countdown",
				op: "open",
				match_on: { task_id: "01JB6X000000000000000000T7" },
				tag: "dishes",
				duration_ms: 3_600_000,
			},
		]);
	});

	it("R4 closes by task_id exactly what R22 opened (assign→complete pairing, ADR 0004)", () => {
		const assigned = evaluateRules(DEFAULT_RULES, {
			type: "task_assigned",
			metadata: { task_id: "t7", duration_ms: 60_000 },
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
		});
		const completed = evaluateRules(DEFAULT_RULES, {
			type: "task_completed",
			metadata: { task_id: "t7" },
			occurred_at: 2,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
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

	it("two tasks sharing a name open distinguishable countdowns, each closed by its own completion (ADR 0005)", () => {
		// The collision minting exists to remove: assign "dishes" Monday, assign it
		// again Tuesday while Monday's countdown still runs. With a hand-typed
		// `task_id` both rows carried `{task_id: "dishes"}` and a close resolved
		// oldest-open-wins, so Tuesday's completion discharged Monday's countdown.
		const assign = (taskId: string, at: number): OpenStopwatch => {
			const { fired } = evaluateRules(DEFAULT_RULES, {
				type: "task_assigned",
				metadata: { task_id: taskId, task_name: "dishes", duration_ms: 60_000 },
				occurred_at: at,
				active_timers: new Set<string>(),
				counter_values: NO_COUNTER_VALUES,
			});
			const op = fired
				.flatMap((f) => f.ops)
				.find((o) => o.kind === "timer" && o.op === "open");
			if (op?.kind !== "timer") throw new Error("R22 did not open a countdown");
			return {
				id: `row-${taskId}`,
				timer: "task_countdown",
				match: op.match_on ?? {},
				opened_at: at,
				tag: op.tag,
			};
		};
		const monday = assign("01JB6X00000000000000000MON", 1);
		const tuesday = assign("01JB6X00000000000000000TUE", 2);
		const open = [monday, tuesday];

		// Same human name on both rows — the label is display data now, so the two
		// read alike and still resolve apart.
		expect(monday.tag).toBe("dishes");
		expect(tuesday.tag).toBe("dishes");
		expect(monday.match).not.toEqual(tuesday.match);

		for (const row of open) {
			const { fired } = evaluateRules(DEFAULT_RULES, {
				type: "task_completed",
				metadata: { task_id: row.match.task_id },
				occurred_at: 3,
				active_timers: new Set<string>(),
				counter_values: NO_COUNTER_VALUES,
			});
			const closeOp = fired
				.flatMap((f) => f.ops)
				.find((o) => o.kind === "timer" && o.op === "close");
			if (closeOp?.kind !== "timer") throw new Error("R4 did not close");
			expect(matchStopwatch(open, closeOp.match_on)?.id).toBe(row.id);
		}
	});

	it("R23 opens the denial period from a denial_started, routing its duration (ADR 0004)", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "denial_started",
			metadata: { duration_ms: 86_400_000 },
			occurred_at: 500,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
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
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
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
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
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
		// R26 (ADR 0011) joins them: it is sub-qualified too, and its subject
		// mismatch is checked before the ambient clause is ever reached.
		expect(nearMisses.map((n) => n.rule_id).sort()).toEqual([
			"R10",
			"R11",
			"R12",
			"R13",
			"R14",
			"R26",
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
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
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
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
			subject_role: "switch",
		});
		expect(fired).toEqual([]);
	});

	it("a dom-subject infraction feeds no sub projection (#122, ADR 0003)", () => {
		// The infraction family never got ADR 0003's treatment, so every one of
		// R6–R9 fired on a dom-subject event and landed on the *sub's* unqualified
		// projections: their lifetime tally, their demerits, and — most visibly —
		// their good-behaviour clock. A limit binds the dom, so citing one in an
		// infraction about them is a normal thing to do; it must record, not score.
		const { fired, nearMisses } = evaluateRules(DEFAULT_RULES, {
			type: "infraction",
			// Ruled major and not self-reported: were the sub rules in play, this is
			// the maximum-fan-out shape. None of it may fire.
			metadata: { severity: "major", self_reported: false },
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
			subject_role: "dom",
		});
		expect(fired).toEqual([]);

		// Dormant *legibly*: the trace says the subject is why, for each rule whose
		// metadata would otherwise have matched.
		const reasons = new Map(nearMisses.map((n) => [n.rule_id, n.reason]));
		for (const id of ["R6", "R7", "R8"]) {
			expect(reasons.get(id)).toContain("subject is not the sub");
		}
	});

	it("a sub-subject infraction is untouched by the qualifier", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "infraction",
			metadata: { severity: "major", self_reported: false },
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
			subject_role: "sub",
		});
		expect(fired.map((f) => f.rule_id).sort()).toEqual(["R6", "R7", "R8"]);
	});

	it("keeps a dom-subject infraction out of the queue (#122, ADR 0003)", () => {
		// The other half: with `severity` awaited unqualified, a sub logging their
		// dom's breach put it in the *dom's* own queue, awaiting their ruling on
		// themselves — the exact shape ADR 0003 removed for orgasms.
		const infraction = STARTER_EVENT_TYPES.find((t) => t.id === "infraction");
		expect(infraction).toBeDefined();
		if (!infraction) return;

		expect(awaitingKeysFor(infraction.awaiting, "sub")).toEqual(["severity"]);
		expect(awaitingKeysFor(infraction.awaiting, "dom")).toEqual([]);
	});

	it("replay determinism across the bump: old events keep the unqualified versions (ADR 0002 + 0003)", () => {
		// A couple seeded on the pre-qualifier pack: drop R21 (which didn't exist)
		// and strip subject_role to reconstruct the v3 definitions, installed at 0.
		// Only the orgasm family is un-qualified here — the infraction rules gained
		// their qualifier in a later bump (#122), so un-qualifying them too would
		// put them in `upserted` and misdescribe what the ADR 0003 bump changed.
		const BUMP_AT = 1_000;
		// This bump predates the edge rules (R24/R25), the ADR 0011 pair (R26/R27)
		// and the redemption rule (R28); scope the reconstruction to the
		// qualifier-era pack so later arrivals don't pollute the added/upserted sets.
		const qualifierPack = DEFAULT_RULES.filter(
			(r) => !["R24", "R25", "R26", "R27", "R28"].includes(r.id),
		);
		const oldPack = qualifierPack
			.filter((r) => r.id !== "R21")
			.map((r) =>
				r.condition.type === "orgasm"
					? {
							...r,
							condition: {
								type: r.condition.type,
								metadata: r.condition.metadata,
							},
						}
					: r,
			);
		const installed = reconcilePack(oldPack, [], 0).added;
		const bump = reconcilePack(qualifierPack, installed, BUMP_AT);
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
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
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

	it("replay determinism across the #122 bump: a mis-scored past stays scored (ADR 0002)", () => {
		// Forward-only cuts both ways. Qualifying R6–R9 stops *new* dom-subject
		// infractions touching the sub's projections, but a rebuild must still
		// reproduce the demerits they already received — the log records what the
		// couple actually lived with, and ADR 0002 forbids re-deriving history under
		// today's rules. Correcting the record is an amendment's job, not a bump's.
		const BUMP_AT = 2_000;
		const oldPack = DEFAULT_RULES.map((r) =>
			r.condition.type === "infraction"
				? {
						...r,
						condition: {
							type: r.condition.type,
							metadata: r.condition.metadata,
						},
					}
				: r,
		);
		const installed = reconcilePack(oldPack, [], 0).added;
		const bump = reconcilePack(DEFAULT_RULES, installed, BUMP_AT);
		expect(bump.added).toEqual([]);
		expect(bump.upserted.map((u) => u.id).sort()).toEqual([
			"R6",
			"R7",
			"R8",
			"R9",
		]);

		const history = installed.map((rule) => ({
			...rule,
			versions: [
				...rule.versions,
				...bump.upserted.filter((u) => u.id === rule.id).map((u) => u.version),
			],
		}));
		const domInfraction = {
			type: "infraction",
			metadata: { severity: "major", self_reported: false },
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
			subject_role: "dom" as const,
		};
		const before = evaluateRules(
			rulesEffectiveAt(history, BUMP_AT - 1),
			domInfraction,
		);
		expect(before.fired.map((f) => f.rule_id).sort()).toEqual([
			"R6",
			"R7",
			"R8",
		]);
		const after = evaluateRules(
			rulesEffectiveAt(history, BUMP_AT),
			domInfraction,
		);
		expect(after.fired).toEqual([]);
	});

	it("R19 opens a journal_countdown on a journal_prompt, tagged with the floor", () => {
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "journal_prompt",
			metadata: { prompt_id: "p1", floor: "shared" },
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
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
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
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

/**
 * The pack's citing refs (#121, ADR 0006). These two keys were the last
 * unstructured refs in the app — free text naming nothing the app held a row for
 * — and they are what makes the corpus reachable from the log.
 */
describe("citing refs in the shipped pack", () => {
	const fieldOn = (typeId: string, key: string) => {
		const type = STARTER_EVENT_TYPES.find((t) => t.id === typeId);
		if (!type) throw new Error(`no ${typeId} in the pack`);
		const field = type.metadata[key];
		if (!field) throw new Error(`no ${typeId}.${key}`);
		return field;
	};

	it("an infraction cites an Agreement, and no longer calls it a Rule", () => {
		// The collision this whole line of work removed: a sub logging an
		// infraction was asked for a "Rule" while "Rules" meant automation.
		const field = fieldOn("infraction", "rule_ref");
		expect(isCitingRef(field)).toBe(true);
		expect(field.label).toBe("Agreement");
	});

	it("a completed ritual cites a ritual, not the whole corpus", () => {
		// Narrowed on purpose: logging a ritual must not offer the couple's limits.
		const field = fieldOn("ritual_completed", "ritual_id");
		expect(isCitingRef(field)).toBe(true);
		expect(field.kind === "ref" && field.agreement_kind).toBe("ritual");
	});

	it("keeps both keys' names, so stored citations and rule conditions still match", () => {
		// ADR 0005's precedent: semantics change, history is left alone. Renaming
		// would orphan every citation already logged *and* silently break any rule
		// condition keyed on the old name.
		expect(
			agreementRefKeys(
				STARTER_EVENT_TYPES.find((t) => t.id === "infraction") ?? {
					metadata: {},
				},
			),
		).toEqual(["rule_ref"]);
		expect(
			agreementRefKeys(
				STARTER_EVENT_TYPES.find((t) => t.id === "ritual_completed") ?? {
					metadata: {},
				},
			),
		).toEqual(["ritual_id"]);
	});

	it("no citing ref is minted — nothing mints a definition that already exists", () => {
		for (const type of STARTER_EVENT_TYPES) {
			for (const key of agreementRefKeys(type)) {
				expect(isOriginatingRef(type.metadata[key])).toBe(false);
			}
		}
	});
});

describe("acts in the shipped pack (#182)", () => {
	const typeById = (id: string) => {
		const type = STARTER_EVENT_TYPES.find((t) => t.id === id);
		if (!type) throw new Error(`no ${id} in the pack`);
		return type;
	};

	it("an act awaits nothing — it is a record, never a ruling", () => {
		// The decision, not an oversight. Nobody adjudicates an act: asserting a
		// verdict nobody asked for is the less truthful record, and `awaiting`
		// qualifies on subject_role only, so it could never have told "the dom did
		// this to the sub" apart from "the sub did this". An empty `awaiting` is
		// what keeps an act out of the queue and out of the unread badge.
		expect(typeById("act").awaiting).toEqual([]);
		for (const [key, field] of Object.entries(typeById("act").metadata)) {
			expect({ key, adjudicated_by: field.adjudicated_by }).toEqual({
				key,
				adjudicated_by: undefined,
			});
		}
	});

	it("every act-shaped type can name the session it happened in", () => {
		// `orgasm` and `edge` were acts already and could not be linked to the
		// session they occurred in, so a session could never report its contents.
		// The ref echoes an id it does not close — never minted here, or the server
		// would assign a fresh one instead of pairing with the running session.
		for (const id of ["act", "orgasm", "edge"]) {
			const field = typeById(id).metadata.session_id;
			expect({ id, kind: field?.kind }).toEqual({ id, kind: "ref" });
			expect(field?.kind === "ref" && field.ref_kind).toBe("session");
			expect(field?.kind === "ref" && field.minted).toBeUndefined();
			expect(field?.required).toBe(false);
		}
	});
});

/**
 * Option display copy in the pack (#155, ADR 0008). The generic controls fall
 * back to a de-slug for anything the copy misses, which is right for a couple's
 * own enum and wrong here: partial pack copy would look exactly like an
 * oversight, and the surface that gets it would quietly disagree with the ones
 * that don't. So the pack's obligation is total.
 */
describe("option labels in the shipped pack", () => {
	const packEnums = STARTER_EVENT_TYPES.flatMap((type) =>
		Object.entries(type.metadata).flatMap(([key, field]) =>
			field.kind === "enum" ? [{ id: `${type.id}.${key}`, field }] : [],
		),
	);

	it("ships at least one enum to check", () => {
		expect(packEnums.length).toBeGreaterThan(0);
	});

	it("labels every option of every enum", () => {
		for (const { id, field } of packEnums) {
			if (field.kind !== "enum") continue;
			const unlabelled = field.options.filter((o) => !field.option_labels?.[o]);
			expect({ id, unlabelled }).toEqual({ id, unlabelled: [] });
		}
	});

	it("labels nothing the enum doesn't offer", () => {
		// Copy for an option that no longer exists is dead the moment the option
		// is renamed, and reads as though the pack still offers it.
		for (const { id, field } of packEnums) {
			if (field.kind !== "enum") continue;
			const orphaned = Object.keys(field.option_labels ?? {}).filter(
				(o) => !field.options.includes(o),
			);
			expect({ id, orphaned }).toEqual({ id, orphaned: [] });
		}
	});

	it("never restates the stored token as its own label", () => {
		// A label equal to the value (or to its de-slug) is copy that was never
		// written — it would pass the completeness check above and change nothing.
		for (const { id, field } of packEnums) {
			if (field.kind !== "enum") continue;
			for (const option of field.options) {
				expect({
					id,
					option,
					label: field.option_labels?.[option],
				}).not.toEqual({ id, option, label: option });
			}
		}
	});
});

describe("shared vocabularies in the shipped pack (ADR 0018)", () => {
	const shared = new Map<string, { id: string; field: MetadataField }[]>();
	for (const type of STARTER_EVENT_TYPES) {
		for (const [key, field] of Object.entries(type.metadata)) {
			if (field.kind !== "enum" || !field.vocabulary) continue;
			const sites = shared.get(field.vocabulary) ?? [];
			sites.push({ id: `${type.id}.${key}`, field });
			shared.set(field.vocabulary, sites);
		}
	}

	it("groups the shipped pack into one card per Activity", () => {
		// The bug as reported, asserted against the *real* pack rather than a
		// fixture: the vocabulary screen groups by `vocabularySites`, so running
		// the shipped types through it is what the screen will show. Two entries
		// reading "Activity" here is the regression.
		const cards: string[] = [];
		const claimed = new Set<string>();
		for (const type of STARTER_EVENT_TYPES) {
			for (const [key, field] of Object.entries(type.metadata)) {
				if (field.kind !== "enum") continue;
				if (claimed.has(`${type.id}.${key}`)) continue;
				for (const site of vocabularySites(STARTER_EVENT_TYPES, type.id, key)) {
					claimed.add(`${site.type_id}.${site.field_key}`);
				}
				cards.push(field.label);
			}
		}
		expect(cards.filter((label) => label === "Activity")).toEqual(["Activity"]);
		// Nothing else collapsed on the way: one card per enum, less the one the
		// two Activity fields now share.
		const enums = STARTER_EVENT_TYPES.flatMap((t) =>
			Object.values(t.metadata).filter((f) => f.kind === "enum"),
		);
		expect(cards).toHaveLength(enums.length - 1);
	});

	it("ships the activity vocabulary on both session events", () => {
		// The pairing the whole ADR exists for. If a bump ever drops one of these,
		// the assertions below stop guarding anything and would silently pass.
		expect(shared.get("activity")?.map((s) => s.id)).toEqual([
			"session_started.activity",
			"session_ended.activity",
		]);
	});

	it("never declares a vocabulary at only one site", () => {
		// A vocabulary of one is an id that means nothing and reads as though a
		// second site exists — the fan-out has nowhere to fan to.
		for (const [vocabulary, sites] of shared) {
			expect({ vocabulary, count: sites.length }).toEqual({
				vocabulary,
				count: sites.length >= 2 ? sites.length : 2,
			});
		}
	});

	it("ships the same words and copy at every site", () => {
		// The couple's *additions* are kept in step by the DO's fan-out; the pack's
		// own options are kept in step only by this test. Two fields declared one
		// vocabulary and then shipped different lists would be a divergence no
		// runtime code looks for — `withAddedOptions` merges per field and would
		// carry it straight through to a session that starts and cannot stop.
		for (const [vocabulary, sites] of shared) {
			const [first, ...rest] = sites;
			if (first?.field.kind !== "enum") continue;
			for (const site of rest) {
				if (site.field.kind !== "enum") continue;
				expect({
					vocabulary,
					id: site.id,
					options: site.field.options,
				}).toEqual({ vocabulary, id: site.id, options: first.field.options });
				expect({
					vocabulary,
					id: site.id,
					copy: site.field.option_labels,
				}).toEqual({
					vocabulary,
					id: site.id,
					copy: first.field.option_labels,
				});
			}
		}
	});
});

describe("the shipped Agreement kinds", () => {
	it("ships the four categories and no terms", () => {
		expect(DEFAULT_AGREEMENT_KINDS.map((k) => k.id)).toEqual([
			"protocol",
			"ritual",
			"limit",
			"safeword",
		]);
	});

	it("lets anyone hold a limit, and scopes it to its subject", () => {
		// ADR 0010 widened the role list and moved the guarantee onto the scope. The
		// old shape (`[sub, switch]`) protected the sub's limits by *role*, which
		// broke in a switch+sub couple — the switch was in the list too — and meant
		// a dom had nowhere to record a boundary of their own.
		const limit = DEFAULT_AGREEMENT_KINDS.find((k) => k.id === "limit");
		expect(limit?.author_permission).toEqual(["dom", "sub", "switch"]);
		expect(limit?.author_scope).toBe("subject");
	});

	it("scopes every shipped kind deliberately", () => {
		// A kind defaulting to `unscoped` by omission would be a term anyone in the
		// list may move — silently the pre-ADR-0010 behaviour, for the kinds that
		// most need not to have it.
		expect(
			Object.fromEntries(
				DEFAULT_AGREEMENT_KINDS.map((k) => [k.id, k.author_scope]),
			),
		).toEqual({
			protocol: "counterpart",
			ritual: "counterpart",
			limit: "subject",
			safeword: "unscoped",
		});
	});

	it("names a kind for every agreement_kind the pack narrows to", () => {
		// A field narrowing to a kind nobody seeds would offer nothing, for ever,
		// with no error anywhere.
		const ids = new Set(DEFAULT_AGREEMENT_KINDS.map((k) => k.id));
		for (const type of STARTER_EVENT_TYPES) {
			for (const field of Object.values(type.metadata)) {
				if (field.kind === "ref" && field.agreement_kind) {
					expect(ids.has(field.agreement_kind)).toBe(true);
				}
			}
		}
	});
});

describe("R26/R27 — the ADR 0011 pair", () => {
	function orgasm(active: string[], permitted: boolean) {
		return evaluateRules(DEFAULT_RULES, {
			type: "orgasm",
			metadata: { permitted, outcome: "full" },
			occurred_at: 1,
			subject_role: "sub" as const,
			active_timers: new Set(active),
			counter_values: NO_COUNTER_VALUES,
		});
	}

	it("R26 escalates an unpermitted orgasm only while a denial is running", () => {
		const during = orgasm(["denial_period"], false);
		const outside = orgasm([], false);
		expect(during.fired.map((f) => f.rule_id)).toContain("R26");
		expect(outside.fired.map((f) => f.rule_id)).not.toContain("R26");
	});

	it("R26 stacks on R12 rather than replacing it: +2 becomes +4", () => {
		// The escalation is one readable rule, not a rewrite of the base case —
		// R12 keeps scoring the lapse and R26 adds what the denial made of it.
		const demerits = (result: ReturnType<typeof orgasm>) =>
			result.fired
				.flatMap((f) => f.ops)
				.filter((op) => op.kind === "counter" && op.counter === "demerits")
				.reduce(
					(sum, op) => sum + (op.kind === "counter" ? (op.by ?? 1) : 0),
					0,
				);
		expect(demerits(orgasm([], false))).toBe(2);
		expect(demerits(orgasm(["denial_period"], false))).toBe(4);
	});

	it("R14 still closes the denial independently of R26", () => {
		// The two do different jobs on the same event: R14 ends the period, R26
		// scores what ending it that way cost.
		const during = orgasm(["denial_period"], false);
		expect(during.fired.map((f) => f.rule_id)).toContain("R14");
	});

	it("R26 leaves a permitted orgasm alone, denial or not", () => {
		expect(
			orgasm(["denial_period"], true).fired.map((f) => f.rule_id),
		).not.toContain("R26");
	});

	it("R26's silence during no denial is legible in the trace", () => {
		// Everything else about the event matched, so the near-miss earns its row:
		// this rule was considered and the mode is why it stayed out.
		const { nearMisses } = orgasm([], false);
		const miss = nearMisses.find((n) => n.rule_id === "R26");
		expect(miss?.reason).toContain("denial_period not active");
		expect(miss?.awaiting).toEqual([]);
	});

	it("R27 notifies the partner on a low mood without needing the flag", () => {
		// R18 needs `wants_conversation` — an explicit ask. R27 reads the number,
		// which is the point: asking is the hard part on a bad day.
		const low = evaluateRules(DEFAULT_RULES, {
			type: "check_in",
			metadata: { mood: 2 },
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
		});
		expect(low.fired.map((f) => f.rule_id)).toContain("R27");

		const fine = evaluateRules(DEFAULT_RULES, {
			type: "check_in",
			metadata: { mood: 4 },
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
		});
		expect(fine.fired.map((f) => f.rule_id)).not.toContain("R27");
	});

	it("R27 stays quiet when no mood was given", () => {
		// A check-in carrying only a flag must not be read as mood 0.
		const { fired } = evaluateRules(DEFAULT_RULES, {
			type: "check_in",
			metadata: { flag: "wants_conversation" },
			occurred_at: 1,
			active_timers: new Set<string>(),
			counter_values: NO_COUNTER_VALUES,
		});
		expect(fired.map((f) => f.rule_id)).not.toContain("R27");
	});
});

describe("the v10 bump installs the ADR 0011 pair", () => {
	/** The couple's installed set before v10: everything the pack ships bar R26/R27. */
	const beforeV10 = DEFAULT_RULES.filter(
		(r) => r.id !== "R26" && r.id !== "R27",
	).map((r) => ({
		id: r.id,
		origin: "pack" as const,
		adopted: false,
		versions: [{ ...r, effective_from: 0 }],
	}));

	it("adds R26 and R27 and touches nothing else", () => {
		const bump = reconcilePack(DEFAULT_RULES, beforeV10, 1_000);
		expect(bump.added.map((r) => r.id)).toEqual(["R26", "R27"]);
		expect(bump.upserted).toEqual([]);
	});

	it("still adds them to a couple who has adopted half the pack", () => {
		// Adoption freezes a rule against overwrites (#159); it must not freeze the
		// couple out of rules the pack has not shipped them yet.
		const withAdopted = beforeV10.map((r) =>
			r.id === "R12" ? { ...r, adopted: true } : r,
		);
		const bump = reconcilePack(DEFAULT_RULES, withAdopted, 1_000);
		expect(bump.added.map((r) => r.id)).toEqual(["R26", "R27"]);
		expect(bump.skipped.map((s) => s.id)).toEqual(["R12"]);
	});

	it("re-running the bump adds nothing twice", () => {
		const settled = reconcilePack(DEFAULT_RULES, beforeV10, 1_000);
		const installed = [...beforeV10, ...settled.added];
		const again = reconcilePack(DEFAULT_RULES, installed, 2_000);
		expect(again.added).toEqual([]);
		expect(again.upserted).toEqual([]);
	});
});
