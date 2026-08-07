import { describe, expect, it } from "vitest";
import {
	DEFAULT_COUNTERS,
	DEFAULT_EVENT_TYPES,
	DEFAULT_RULES,
} from "#/templates/index.ts";
import type { VersionedAgreement } from "./agreements.ts";
import type { Counter } from "./counters.ts";
import { firstRunStep } from "./first-run.ts";
import type { Rule } from "./rules.ts";
import { scaffoldPlan } from "./scaffold.ts";
import { targetRows } from "./target-rows.ts";

/**
 * What a couple who has not started yet should do next (#212).
 *
 * These run against the **shipped pack**, not hand-built fixtures, because the
 * whole reason this function exists is a fact about the seeds: they are what make
 * Today non-blank on a fresh install. A fixture would let that fact drift out
 * from under the copy without failing anything.
 */

const NOW = 1_700_000_000_000;

/** The counters a couple has the minute their DO is seeded: pack definitions at 0. */
const SEEDED: Counter[] = DEFAULT_COUNTERS.map((definition) => ({
	...definition,
	value: 0,
	updated_at: 0,
})) as Counter[];

const PACK_RULES: Rule[] = DEFAULT_RULES;

function ritual(over: Partial<VersionedAgreement> = {}): VersionedAgreement {
	return {
		id: "ag_ritual",
		kind: "ritual",
		subject: "m_sub",
		versions: [
			{
				effective_from: NOW - 10_000,
				name: "morning kneel",
				text: "",
				retired: false,
			},
		],
		...over,
	};
}

const step = (over: Partial<Parameters<typeof firstRunStep>[0]> = {}) =>
	firstRunStep({
		agreements: [],
		counters: SEEDED,
		rules: PACK_RULES,
		types: DEFAULT_EVENT_TYPES,
		now: NOW,
		...over,
	});

describe("the seeded state this exists for", () => {
	it("leaves a fresh couple one target row they cannot tick", () => {
		// The premise, pinned. `rituals_completed_today` ships with a daily target so
		// `targetRows` yields a row from minute one — and R1 increments it with an
		// empty metadata clause, which is exactly what `tickFor` refuses to build a
		// tick from. If either fact changes, the floor's copy is wrong and this
		// fails rather than the copy quietly lying.
		const rows = targetRows({
			counters: SEEDED,
			rules: PACK_RULES,
			types: DEFAULT_EVENT_TYPES,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].counter.id).toBe("rituals_completed_today");
		expect(rows[0].tickLogs).toBeNull();
	});

	it("leaves that row claiming no provenance", () => {
		// The other half of the same premise (#212 item 5). The seeded row did not
		// come from anything the couple agreed — R1 cites nothing — so the panel
		// must say nothing about where it came from. Pinned against the pack for the
		// reason above: a seed that later cited a term would make the row's silence
		// wrong, and this fails instead of the screen quietly under-explaining it.
		const rows = targetRows({
			counters: SEEDED,
			rules: PACK_RULES,
			types: DEFAULT_EVENT_TYPES,
		});
		expect(rows[0].tracks).toBeNull();
	});
});

describe("firstRunStep", () => {
	it("sends a couple with an empty corpus to write something down", () => {
		// Nothing ships in the corpus on purpose, so there is genuinely no earlier
		// step to suggest.
		expect(step()).toBe("write");
	});

	it("sends a couple with an untracked ritual to track it", () => {
		expect(step({ agreements: [ritual()] })).toBe("track");
	});

	it("sends them to the log once something is tickable", () => {
		// The artifacts the Agreements screen would create, built from the same pure
		// function the server builds from — so this is the real post-tracking state
		// rather than a guess at it.
		const plan = scaffoldPlan({
			agreementId: "ag_ritual",
			name: "morning kneel",
			eventTypeId: "ritual_completed",
			refKey: "ritual_id",
		});
		const counters: Counter[] = [
			...SEEDED,
			{ ...plan.counter, value: 0, updated_at: 0 } as Counter,
			{ ...plan.streak, value: 0, updated_at: 0 } as Counter,
		];
		expect(
			firstRunStep({
				agreements: [ritual()],
				counters,
				rules: [...PACK_RULES, plan.rule],
				types: DEFAULT_EVENT_TYPES,
				now: NOW,
			}),
		).toBe("log");
	});

	it("does not suggest tracking a limit", () => {
		// Nothing in the pack *counts* limits: only `ritual_completed.ritual_id`
		// names a kind, and it names `ritual`. The Agreements screen does currently
		// offer "Track this" here, via `countingTypeFor` falling through to
		// `infraction`'s unqualified ref — which scaffolds a daily target for
		// breaking your own limit (#213). This must not repeat that reasoning, and
		// this test is what holds the two apart until #213 lands.
		expect(step({ agreements: [ritual({ kind: "limit" })] })).toBe("log");
	});

	it("does not suggest tracking a safeword either", () => {
		expect(step({ agreements: [ritual({ kind: "safeword" })] })).toBe("log");
	});

	it("ignores a retired term, which is readable but not a starting point", () => {
		const retired = ritual({
			versions: [
				...ritual().versions,
				{
					effective_from: NOW - 5_000,
					name: "morning kneel",
					text: "",
					retired: true,
				},
			],
		});
		expect(step({ agreements: [retired] })).toBe("write");
	});

	it("ignores a term dated ahead, which governs nothing yet", () => {
		// The announced-draft case: written, visible, and not yet in force. Telling
		// someone to track a term that does not bind anybody would be premature.
		const announced = ritual({
			versions: [
				{
					effective_from: NOW + 86_400_000,
					name: "morning kneel",
					text: "",
					retired: false,
				},
			],
		});
		expect(step({ agreements: [announced] })).toBe("write");
	});

	it("does not re-offer tracking for a term already tracked", () => {
		// Tracked by a hand-built rule rather than the scaffold, since `isTracked`
		// deliberately recognises either — the rule *is* the record (ADR 0006).
		const byHand: Rule = {
			id: "R_custom",
			name: "Morning kneel",
			condition: {
				type: "ritual_completed",
				metadata: { ritual_id: "ag_ritual" },
			},
			effects: [
				{ verb: "increment_counter", counter: "tasks_completed", by: 1 },
			],
			enabled: true,
		};
		expect(
			step({ agreements: [ritual()], rules: [...PACK_RULES, byHand] }),
		).toBe("log");
	});
});
