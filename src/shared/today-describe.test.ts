import { describe, expect, it } from "vitest";
import type { AnchorView } from "./anchors.ts";
import type { Counter } from "./counters.ts";
import type { VersionedRewardItem } from "./rewards.ts";
import type { TargetRow } from "./target-rows.ts";
import {
	describeClocks,
	describeLadders,
	describeTargets,
	describeTracking,
	describeWithinReach,
} from "./today-describe.ts";

/**
 * The derived half of Today's panel explainers (#212 item 2).
 *
 * These are sentences, so the tests are about what each one *claims* rather than
 * its wording: that a dash is explained as a dash and never as a zero, that the
 * ladder banner always says it clears itself, that a currency is named, and that
 * a row with no button is the row the sentence names. Asserting on substrings
 * keeps a copy edit from being a test failure while a claim going missing still
 * is one.
 */

function counter(partial: Partial<Counter> & Pick<Counter, "id">): Counter {
	return {
		name: partial.id,
		valence: "neutral",
		target_direction: "floor",
		reset: "never",
		rungs: [],
		modify_permission: ["dom", "sub", "switch"],
		value: 0,
		updated_at: null,
		...partial,
	};
}

/**
 * `days` null is the never-reset anchor — the one that renders "—". Kept in step
 * with `since` here, which is what real data does; the note counts `elapsed_days`
 * because that is the field the panel puts on screen.
 */
function anchor(days: number | null): AnchorView {
	return {
		anchor: `a${days ?? "never"}`,
		since: days === null ? null : 1,
		elapsed_ms: days === null ? null : days * 86_400_000,
		elapsed_days: days,
	};
}

describe("describeClocks", () => {
	it("says nothing about dashes when every clock has been reset", () => {
		const note = describeClocks([anchor(1), anchor(2)]);
		expect(note).not.toContain("—");
		expect(note).toContain("your log");
	});

	// The whole point of the sentence: "—" and "0" look alike at a glance and mean
	// opposite things, so the one that is showing has to be named against the one
	// that isn't.
	it("distinguishes a never-reset dash from a zero", () => {
		for (const anchors of [
			[anchor(null)],
			[anchor(null), anchor(null)],
			[anchor(null), anchor(5)],
			[anchor(null), anchor(null), anchor(5)],
		]) {
			const note = describeClocks(anchors);
			expect(note).toContain("“—”");
			expect(note).toContain("rather than 0");
		}
	});

	it("counts the unset ones when only some are", () => {
		expect(describeClocks([anchor(null), anchor(null), anchor(5)])).toContain(
			"2 of these",
		);
	});

	it("agrees with itself about number", () => {
		expect(describeClocks([anchor(null), anchor(5)])).toContain("One of these");
		expect(describeClocks([anchor(null), anchor(5)])).toContain("it reads");
	});
});

describe("describeLadders", () => {
	const DEMERITS = counter({ id: "demerits", name: "Demerits", value: 12 });

	// A crossing is "a recorded moment, not a debt" (CONTEXT §Crossing). The banner
	// is bordered, tinted, and sits at the top of the landing screen, which reads as
	// an inbox item until something says otherwise — so this claim is the one that
	// must survive every branch.
	it("always says there is nothing to dismiss", () => {
		const one = [
			{ counter: DEMERITS, rung: { at: 10, agreement_ref: "ag_1" } },
		];
		expect(describeLadders(one)).toContain("nothing here to dismiss");
		expect(
			describeLadders([
				...one,
				{ counter: DEMERITS, rung: { at: 5, agreement_ref: "ag_2" } },
			]),
		).toContain("nothing here to dismiss");
	});

	it("names the number it clears under while there is only one", () => {
		const note = describeLadders([
			{ counter: DEMERITS, rung: { at: 10, agreement_ref: "ag_1" } },
		]);
		expect(note).toContain("Demerits is at 12");
		expect(note).toContain("under 10");
	});

	// With several, the rows each carry their own number and a sentence reciting
	// them is worse than the rows.
	it("stops naming numbers once there are several", () => {
		const note = describeLadders([
			{ counter: DEMERITS, rung: { at: 10, agreement_ref: "ag_1" } },
			{ counter: DEMERITS, rung: { at: 5, agreement_ref: "ag_2" } },
		]);
		expect(note).not.toContain("12");
		expect(note).toContain("its counter");
	});

	// Unreachable from the panel, which returns null when nothing is standing —
	// but a sentence reading "0 rungs" is exactly what the plural branch was
	// written to avoid, so it is pinned rather than left to a future edit.
	it("stays a sentence with nothing standing", () => {
		expect(describeLadders([])).toContain("nothing here to dismiss");
		expect(describeLadders([])).not.toContain("0");
	});
});

describe("describeWithinReach", () => {
	const OBEDIENCE = counter({ id: "obedience", name: "Obedience", value: 40 });
	const SERVICE = counter({ id: "service", name: "Service", value: 7 });

	function item(id: string, currency: string, price: number) {
		return {
			id,
			versions: [
				{
					effective_from: 0,
					name: id,
					terms: "",
					currency,
					price,
					requires_grant: true,
					retired: false,
				},
			],
		} satisfies VersionedRewardItem;
	}

	it("names the currency and what it stands at", () => {
		const note = describeWithinReach(
			[item("bath", "obedience", 30)],
			[OBEDIENCE, SERVICE],
			1,
		);
		expect(note).toContain("Obedience at 40");
		expect(note).not.toContain("Service");
	});

	// Each score is its own counter (ADR 0015), so two currencies is ordinary, and
	// it is the case where "why is this here" has more than one answer.
	it("names every currency in play, once each", () => {
		const note = describeWithinReach(
			[
				item("bath", "obedience", 30),
				item("film", "obedience", 10),
				item("lie-in", "service", 5),
			],
			[OBEDIENCE, SERVICE],
			1,
		);
		expect(note).toContain("Obedience at 40");
		expect(note).toContain("Service at 7");
		expect(note.match(/Obedience/g)).toHaveLength(1);
		expect(note).toContain("they stand");
	});

	it("falls back rather than inventing a currency it cannot find", () => {
		const note = describeWithinReach([item("free", "gone", 0)], [OBEDIENCE], 1);
		expect(note).toContain("saved up");
		expect(note).not.toContain("gone");
	});
});

describe("describeTargets", () => {
	function row(
		name: string,
		tickable: boolean,
		id = name.toLowerCase(),
	): TargetRow {
		return {
			counter: counter({ id, name, daily_target: 1 }),
			target: 1,
			period: "daily",
			streak: null,
			met: false,
			tickLogs: tickable ? { type: "ritual_completed", metadata: {} } : null,
			tracks: null,
		};
	}

	it("says every row has a button when every row does", () => {
		const note = describeTargets([row("Kneel", true), row("Journal", true)]);
		expect(note).toContain("Every row here has a button");
	});

	// The case this function exists for: the pack seeds
	// `rituals_completed_today` and R1 increments it unconditionally, so the first
	// row a new couple ever sees is a readout (#212, #214).
	it("names the row that has no button", () => {
		const note = describeTargets([
			row("Rituals completed today", false),
			row("Kneel", true),
		]);
		expect(note).toContain("“Rituals completed today” has no button");
		expect(note).toContain("it counts");
		expect(note).toContain("a readout");
	});

	it("names two, counts three", () => {
		expect(describeTargets([row("One", false), row("Two", false)])).toContain(
			"“One” and “Two” have no button",
		);
		expect(
			describeTargets([
				row("One", false),
				row("Two", false),
				row("Three", false),
			]),
		).toContain("3 of these have no button");
	});

	// Provenance (#212 item 5). The confirm sheet explains the three scaffolded
	// artifacts once; after that they sit on Today with nothing tying them to the
	// term, and ADR 0006 stores no link to tie them with.
	describe("describeTracking", () => {
		const tracked = (term: string | null): TargetRow => ({
			...row("Morning kneel", true),
			tracks: term,
		});

		it("says nothing for a row whose rules cite no term", () => {
			// The pack's seeded row: it came from the app, not from anything agreed.
			expect(describeTracking(tracked(null), { ag_7f3: "x" })).toBeNull();
		});

		it("names the term", () => {
			expect(
				describeTracking(tracked("ag_7f3"), { ag_7f3: "Morning kneel" }),
			).toContain("“Morning kneel”");
		});

		it("keeps the relationship when the term can't be named", () => {
			// Never the raw id: on a glance screen beside a real name it would read
			// as a second, broken term. The fact is still true and still worth saying.
			const note = describeTracking(tracked("ag_gone"), {});
			expect(note).toContain("one of your agreements");
			expect(note).not.toContain("ag_gone");
		});
	});

	it("agrees with itself about number", () => {
		const many = describeTargets([row("One", false), row("Two", false)]);
		expect(many).toContain("they count");
		expect(many).toContain("readouts");
		const one = describeTargets([row("One", false)]);
		expect(one).toContain("it counts");
		expect(one).toContain("a readout");
	});
});
