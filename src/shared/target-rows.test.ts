import { describe, expect, it } from "vitest";
import type { Counter } from "./counters.ts";
import type { EventType } from "./event-types.ts";
import type { Rule } from "./rules.ts";
import { targetRows } from "./target-rows.ts";

/**
 * What Today shows you are aiming at (#135, handoff §9.2). Pure, like
 * `ref-candidates.ts`, and derived from the same input for the same reason: the
 * couple's own rules already say which counter counts what, so a hardcoded list
 * would go stale the moment they scaffold a ritual.
 */

function counter(partial: Partial<Counter> & Pick<Counter, "id">): Counter {
	return {
		name: partial.id,
		valence: "neutral",
		reset: "never",
		modify_permission: ["dom", "sub", "switch"],
		value: 0,
		updated_at: null,
		...partial,
	};
}

/** The pack's shape: a daily target and a streak counter folding it. */
const RITUALS = counter({
	id: "rituals_completed_today",
	name: "Rituals",
	daily_target: 1,
	reset: "daily",
});
const RITUAL_STREAK = counter({
	id: "ritual_streak_days",
	name: "Ritual streak",
	value: 4,
	streak: { counter: "rituals_completed_today", period: "daily" },
});

/** What #121's scaffolding generates for one tracked ritual. */
const KNEEL = counter({
	id: "ag_7f3_today",
	name: "Morning kneel",
	daily_target: 1,
	reset: "daily",
});
const KNEEL_RULE: Rule = {
	id: "custom-kneel",
	enabled: true,
	condition: {
		type: "ritual_completed",
		metadata: { ritual_id: "ag_7f3" },
	},
	effects: [{ verb: "increment_counter", counter: "ag_7f3_today", by: 1 }],
};

const TYPES: EventType[] = [
	{
		id: "ritual_completed",
		label: "Ritual completed",
		valence: "positive",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {
			ritual_id: {
				kind: "ref",
				ref_kind: "agreement",
				agreement_kind: "ritual",
				label: "Ritual",
				required: false,
				set_permission: ["dom", "sub", "switch"],
			},
		},
		awaiting: [],
		journaling: false,
	},
];

const rows = (over: Partial<Parameters<typeof targetRows>[0]> = {}) =>
	targetRows({ counters: [], rules: [], types: TYPES, ...over });

describe("targetRows — which counters appear", () => {
	it("shows a counter carrying a target", () => {
		expect(rows({ counters: [RITUALS] }).map((r) => r.counter.id)).toEqual([
			"rituals_completed_today",
		]);
	});

	it("leaves out a counter with no target", () => {
		// "Am I on track?" is unanswerable without one, and the Log's counters
		// panel already shows everything.
		const demerits = counter({ id: "demerits", name: "Demerits", value: 2 });
		expect(rows({ counters: [demerits] })).toEqual([]);
	});

	it("shows a weekly-target counter, labelled for its period", () => {
		// It would otherwise appear nowhere: there is no week view to wait for.
		const weekly = counter({
			id: "check_ins_week",
			name: "Check-ins",
			weekly_target: 3,
			reset: "weekly",
		});
		expect(rows({ counters: [weekly] })[0]).toMatchObject({
			target: 3,
			period: "weekly",
		});
	});

	it("prefers the daily target when a counter carries both", () => {
		// The screen is Today; a weekly figure beside it would answer a question
		// nobody asked here.
		const both = counter({
			id: "c",
			daily_target: 1,
			weekly_target: 5,
		});
		expect(rows({ counters: [both] })[0]).toMatchObject({
			target: 1,
			period: "daily",
		});
	});

	it("never gives a streak a row of its own", () => {
		// CONTEXT §Target counter: a streak is "a property of one", not a sibling.
		// A row for it would contradict the model on screen.
		expect(
			rows({ counters: [RITUALS, RITUAL_STREAK] }).map((r) => r.counter.id),
		).toEqual(["rituals_completed_today"]);
	});
});

describe("targetRows — the streak inside its row", () => {
	it("carries the streak's length on the counter it folds", () => {
		expect(rows({ counters: [RITUALS, RITUAL_STREAK] })[0]?.streak).toEqual({
			length: 4,
			period: "daily",
		});
	});

	it("is null when nothing folds this counter", () => {
		expect(rows({ counters: [RITUALS] })[0]?.streak).toBeNull();
	});
});

describe("targetRows — met", () => {
	it("is false below the target", () => {
		expect(rows({ counters: [RITUALS] })[0]?.met).toBe(false);
	});

	it("is true at the target", () => {
		expect(rows({ counters: [{ ...RITUALS, value: 1 }] })[0]?.met).toBe(true);
	});

	it("stays true past it", () => {
		expect(rows({ counters: [{ ...RITUALS, value: 3 }] })[0]?.met).toBe(true);
	});
});

describe("targetRows — what a tick logs", () => {
	it("derives the event from the rule that drives the counter", () => {
		// The link #121's scaffolding deliberately did not store: the generated
		// rule *is* it, read the way ref candidates are read.
		expect(
			rows({ counters: [KNEEL], rules: [KNEEL_RULE] })[0]?.tickLogs,
		).toEqual({
			type: "ritual_completed",
			metadata: { ritual_id: "ag_7f3" },
		});
	});

	it("is not tickable when no rule drives the counter", () => {
		// A hand-made target counter: there is nothing honest to log for it, so it
		// stays a readout rather than getting a button that records the wrong act.
		expect(rows({ counters: [RITUALS] })[0]?.tickLogs).toBeNull();
	});

	it("is not tickable when the rule matches on something that isn't a citation", () => {
		// `late=true` is a plain metadata equality, not a term the log can cite.
		// Logging it from a tick would assert something the tapper never said.
		const lateRule: Rule = {
			id: "r",
			enabled: true,
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [{ verb: "increment_counter", counter: "ag_7f3_today", by: 1 }],
		};
		expect(
			rows({ counters: [KNEEL], rules: [lateRule] })[0]?.tickLogs,
		).toBeNull();
	});

	it("ignores a disabled rule", () => {
		// A disabled rule fires nothing, so ticking through it would move no
		// counter — a button that looks like it worked and didn't.
		expect(
			rows({
				counters: [KNEEL],
				rules: [{ ...KNEEL_RULE, enabled: false }],
			})[0]?.tickLogs,
		).toBeNull();
	});

	it("ignores a rule that decrements rather than increments", () => {
		const down: Rule = {
			...KNEEL_RULE,
			effects: [{ verb: "decrement_counter", counter: "ag_7f3_today", by: 1 }],
		};
		expect(rows({ counters: [KNEEL], rules: [down] })[0]?.tickLogs).toBeNull();
	});

	it("is not tickable when the type is gone", () => {
		// The couple dropped the event type but kept the rule: nothing to log.
		expect(
			rows({ counters: [KNEEL], rules: [KNEEL_RULE], types: [] })[0]?.tickLogs,
		).toBeNull();
	});

	it("stays tickable for a rule that also qualifies on subject", () => {
		// ADR 0003 qualifiers are about *whose* event fires it, not about what the
		// tapper is asserting, so they must not disable the tick.
		const qualified: Rule = {
			...KNEEL_RULE,
			condition: { ...KNEEL_RULE.condition, subject_role: "sub" },
		};
		expect(
			rows({ counters: [KNEEL], rules: [qualified] })[0]?.tickLogs,
		).toEqual({
			type: "ritual_completed",
			metadata: { ritual_id: "ag_7f3" },
		});
	});
});

describe("targetRows — cases the review found untested", () => {
	it("carries a weekly streak's period, so it is not rendered as days", () => {
		// Constructible today through the Log's counters form, and the panel would
		// otherwise call a 3-week streak "3-day".
		const weeklyStreak = counter({
			id: "s",
			value: 3,
			streak: { counter: "rituals_completed_today", period: "weekly" },
		});
		expect(rows({ counters: [RITUALS, weeklyStreak] })[0]?.streak).toEqual({
			length: 3,
			period: "weekly",
		});
	});

	it("is not tickable through the pack's own R1", () => {
		// R1 is `ritual_completed -> rituals_completed_today` with no metadata: it
		// says "some ritual happened", which names nothing a tick could cite. This
		// is the rule driving the one target counter that ships on day one.
		const r1: Rule = {
			id: "R1",
			enabled: true,
			condition: { type: "ritual_completed", metadata: {} },
			effects: [
				{
					verb: "increment_counter",
					counter: "rituals_completed_today",
					by: 1,
				},
			],
		};
		expect(rows({ counters: [RITUALS], rules: [r1] })[0]?.tickLogs).toBeNull();
	});

	it("goes read-only when two rules cite different terms into one counter", () => {
		// A button that silently asserts one of two rituals is worse than no
		// button, so the ambiguity disables the tick rather than picking a winner.
		const other: Rule = {
			...KNEEL_RULE,
			id: "other",
			condition: {
				type: "ritual_completed",
				metadata: { ritual_id: "ag_other" },
			},
		};
		expect(
			rows({ counters: [KNEEL], rules: [KNEEL_RULE, other] })[0]?.tickLogs,
		).toBeNull();
	});

	it("still ticks when two rules agree on the same citation", () => {
		// Agreement is not ambiguity: both rules assert the same thing.
		const duplicate: Rule = { ...KNEEL_RULE, id: "duplicate" };
		expect(
			rows({ counters: [KNEEL], rules: [KNEEL_RULE, duplicate] })[0]?.tickLogs,
		).toEqual({ type: "ritual_completed", metadata: { ritual_id: "ag_7f3" } });
	});
});
