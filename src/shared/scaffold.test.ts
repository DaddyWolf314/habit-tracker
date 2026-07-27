import { describe, expect, it } from "vitest";
import type { EventType } from "./event-types.ts";
import type { Rule } from "./rules.ts";
import {
	citingKeyOf,
	countingTypeFor,
	isTracked,
	scaffoldPlan,
} from "./scaffold.ts";

/**
 * Tracking a ritual (#121, stories 34–37). The plan is a pure function of the
 * Agreement because the dom confirms a preview before anything is created —
 * deriving the preview and the artifacts separately would let the confirmation
 * describe something other than what gets made.
 */

const plan = () =>
	scaffoldPlan({
		agreementId: "ag_7f3",
		name: "morning kneel",
		eventTypeId: "ritual_completed",
		refKey: "ritual_id",
	});

describe("scaffoldPlan", () => {
	it("gives the counter a daily target that resets daily", () => {
		expect(plan().counter).toMatchObject({
			daily_target: 1,
			reset: "daily",
			name: "morning kneel",
		});
	});

	it("makes the streak a fold of that counter, never a rule", () => {
		// CONTEXT §Target counter: "A streak is a property of one… _Avoid_:
		// modeling a streak as a rule."
		const { counter, streak } = plan();
		expect(streak.streak).toEqual({ counter: counter.id, period: "daily" });
		expect(streak.daily_target).toBeUndefined();
	});

	it("cites the Agreement by id, so neither side of the match is typed", () => {
		// The failure #114 named: the same identifier hand-typed into a rule and
		// into every event, where one typo silently stops the rule firing.
		expect(plan().rule.condition).toEqual({
			type: "ritual_completed",
			metadata: { ritual_id: "ag_7f3" },
		});
	});

	it("points the rule at the counter it creates", () => {
		const { counter, rule } = plan();
		expect(rule.effects).toEqual([
			{ verb: "increment_counter", counter: counter.id, by: 1 },
		]);
	});

	it("derives ids from the Agreement's, which is already unique", () => {
		const { counter, streak, rule } = plan();
		expect([counter.id, streak.id, rule.id]).toEqual([
			"ag_7f3_today",
			"ag_7f3_streak",
			"track_ag_7f3",
		]);
	});

	it("takes no id outside the R# namespace the pack reserves", () => {
		expect(/^R\d+$/i.test(plan().rule.id)).toBe(false);
	});

	it("is the same plan every time, so a preview cannot lie", () => {
		expect(plan()).toEqual(plan());
	});
});

describe("citingKeyOf", () => {
	const typeWith = (metadata: EventType["metadata"]): EventType => ({
		id: "ritual_completed",
		label: "Ritual completed",
		valence: "positive",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata,
		awaiting: [],
		journaling: false,
	});

	it("finds the key that names an Agreement", () => {
		expect(
			citingKeyOf(
				typeWith({
					ritual_id: {
						kind: "ref",
						ref_kind: "agreement",
						label: "Ritual",
						required: false,
						set_permission: ["dom", "sub", "switch"],
					},
				}),
			),
		).toBe("ritual_id");
	});

	it("ignores a ref pointing at anything else", () => {
		expect(
			citingKeyOf(
				typeWith({
					task_id: {
						kind: "ref",
						ref_kind: "task",
						label: "Task",
						required: false,
						set_permission: ["dom", "sub", "switch"],
					},
				}),
			),
		).toBeNull();
	});

	it("is null for a type with nothing to cite", () => {
		expect(citingKeyOf(typeWith({}))).toBeNull();
	});
});

/** The shipped shape: a ritual type whose citation names a ritual Agreement. */
const RITUAL_TYPE: EventType = {
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
};

describe("countingTypeFor", () => {
	it("finds the type whose citation counts this kind", () => {
		expect(countingTypeFor("ritual", [RITUAL_TYPE])).toMatchObject({
			refKey: "ritual_id",
		});
	});

	it("finds nothing for a kind no type cites", () => {
		// A limit has nothing to count, so tracking must refuse rather than create
		// a counter no event could ever move.
		expect(countingTypeFor("limit", [RITUAL_TYPE])).toBeNull();
	});

	it("accepts a type that cites any kind", () => {
		const unnarrowed = {
			...RITUAL_TYPE,
			metadata: {
				ritual_id: {
					...RITUAL_TYPE.metadata.ritual_id,
					agreement_kind: undefined,
				},
			},
		} as EventType;
		expect(countingTypeFor("ritual", [unnarrowed])).not.toBeNull();
	});
});

describe("isTracked", () => {
	const tracking: Rule = {
		id: "track_ag_7f3",
		enabled: true,
		condition: { type: "ritual_completed", metadata: { ritual_id: "ag_7f3" } },
		effects: [{ verb: "increment_counter", counter: "ag_7f3_today", by: 1 }],
	};

	it("is true once a rule points the Agreement at a counter", () => {
		expect(isTracked("ag_7f3", [tracking], [RITUAL_TYPE])).toBe(true);
	});

	it("is false for an Agreement nothing points at", () => {
		expect(isTracked("ag_other", [tracking], [RITUAL_TYPE])).toBe(false);
	});

	it("is false once the rule is disabled", () => {
		// Offering tracking again is right: a disabled rule counts nothing.
		expect(
			isTracked("ag_7f3", [{ ...tracking, enabled: false }], [RITUAL_TYPE]),
		).toBe(false);
	});

	it("recognises a recipe the couple built by hand", () => {
		// Nothing is stored to say "this was scaffolded", so what counts as tracked
		// is what the rules actually do — which is also the honest answer.
		const handmade: Rule = {
			...tracking,
			id: "my-own-rule",
			effects: [{ verb: "increment_counter", counter: "kneels", by: 1 }],
		};
		expect(isTracked("ag_7f3", [handmade], [RITUAL_TYPE])).toBe(true);
	});

	it("ignores a rule that cites it without counting anything", () => {
		const noCounter: Rule = {
			...tracking,
			effects: [{ verb: "reset_anchor", anchor: "since_last_infraction" }],
		};
		expect(isTracked("ag_7f3", [noCounter], [RITUAL_TYPE])).toBe(false);
	});
});

describe("isTracked — only a citation counts", () => {
	it("ignores a value that merely equals the id on a non-citing key", () => {
		// Tightened after review: matching any metadata value would read a
		// coincidence as tracking, and disagree with what `tickFor` offers.
		const coincidence: Rule = {
			id: "r",
			enabled: true,
			condition: { type: "ritual_completed", metadata: { late: "ag_7f3" } },
			effects: [{ verb: "increment_counter", counter: "c", by: 1 }],
		};
		const withLate = {
			...RITUAL_TYPE,
			metadata: {
				...RITUAL_TYPE.metadata,
				late: {
					kind: "text",
					label: "Late",
					required: false,
					set_permission: ["dom", "sub", "switch"],
				},
			},
		} as EventType;
		expect(isTracked("ag_7f3", [coincidence], [withLate])).toBe(false);
	});

	it("ignores a rule whose type the couple no longer has", () => {
		const tracking: Rule = {
			id: "r",
			enabled: true,
			condition: { type: "gone", metadata: { ritual_id: "ag_7f3" } },
			effects: [{ verb: "increment_counter", counter: "c", by: 1 }],
		};
		expect(isTracked("ag_7f3", [tracking], [RITUAL_TYPE])).toBe(false);
	});
});
