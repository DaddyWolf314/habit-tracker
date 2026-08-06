import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventType } from "#/shared/event-types.ts";
import {
	type ActiveCouple,
	activeCouple,
	DOM,
	newCoupleDO,
	SUB,
} from "./harness.ts";

/**
 * A couple extending a pack enum, end to end through the DO (#185, ADR 0014).
 *
 * The design's whole claim is that merging at the *type read seam* leaves every
 * downstream consumer unchanged — so what these test is not the merge function
 * (that is unit-tested in `shared/event-types.test.ts`) but the consumers that
 * would otherwise have refused a couple's own word: log validation, amendment
 * validation, rule validation, and `seedDefaults`'s unconditional pack upsert.
 *
 * They are also the argument against the overlay ever becoming a fork. The pack
 * bump case asserts both halves at once — the couple's word survives *and* the
 * pack's change lands — which is exactly the pair adopt-on-edit cannot deliver.
 */

const HOUR = 3_600_000;
const START = Date.parse("2026-01-07T09:00:00.000Z");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});
afterEach(() => {
	vi.useRealTimers();
});

function advance(ms: number): void {
	vi.setSystemTime(Date.now() + ms);
}

/** The `act` type's act vocabulary, as this couple now reads it. */
async function actOptions(couple: ActiveCouple): Promise<string[]> {
	const types = await couple.do.listEventTypes(DOM);
	return enumField(types, "act", "act").options;
}

function enumField(types: EventType[], typeId: string, key: string) {
	const field = types.find((t) => t.id === typeId)?.metadata[key];
	if (field?.kind !== "enum")
		throw new Error(`${typeId}.${key} is not an enum`);
	return field;
}

/** The couple adds "aftercare check" to the act vocabulary. */
async function withAddedAct(): Promise<ActiveCouple> {
	const couple = await activeCouple();
	await couple.do.addEventTypeOption(SUB, {
		type_id: "act",
		field_key: "act",
		option: "aftercare_check",
		label: "Aftercare check",
	});
	return couple;
}

describe("a couple's word joins the pack's", () => {
	it("appears in the type, after the pack's own options", async () => {
		const couple = await withAddedAct();
		const options = await actOptions(couple);

		expect(options.at(-1)).toBe("aftercare_check");
		// The pack's vocabulary is untouched ahead of it — an addition, not a fork.
		const untouched = await activeCouple().then(actOptions);
		expect(options.slice(0, -1)).toEqual(untouched);
	});

	it("carries its label everywhere optionLabel reads", async () => {
		const couple = await withAddedAct();
		const field = enumField(await couple.do.listEventTypes(DOM), "act", "act");

		expect(field.option_labels?.aftercare_check).toBe("Aftercare check");
		// The pack's own copy is still there beside it.
		expect(field.option_labels?.impact).toBeTruthy();
	});

	it("leaves the stored pack definition alone", async () => {
		const couple = await withAddedAct();
		const row = couple.db
			.prepare(`SELECT definition FROM event_types WHERE id = 'act'`)
			.get() as { definition: string };

		expect(JSON.parse(row.definition).metadata.act.options).not.toContain(
			"aftercare_check",
		);
	});
});

describe("the validators that test enum membership accept it", () => {
	it("lets an event be logged with it", async () => {
		const couple = await withAddedAct();
		const event = await couple.do.logEvent(SUB, {
			type: "act",
			metadata: { act: "aftercare_check" },
			subject: couple.subId,
			visibility: "shared",
		});

		expect(event.metadata.act).toBe("aftercare_check");
	});

	it("lets a rule condition on it, and the rule fires", async () => {
		const couple = await withAddedAct();
		await couple.do.createRule(DOM, {
			id: "custom-aftercare-tally",
			name: "Aftercare tally",
			condition: { type: "act", metadata: { act: "aftercare_check" } },
			effects: [{ verb: "increment_counter", counter: "edges_sub", by: 1 }],
		});

		advance(HOUR);
		await couple.do.logEvent(SUB, {
			type: "act",
			metadata: { act: "aftercare_check" },
			subject: couple.subId,
			visibility: "shared",
		});

		const counters = await couple.do.listCounters(DOM);
		expect(counters.find((c) => c.id === "edges_sub")?.value).toBe(1);
	});

	/**
	 * The amendment path runs the same `checkMetadataValue`, and it is the one a
	 * couple-added option reaches *last* — the sub widens the vocabulary, and the
	 * dom rules with it hours later. A merge at any narrower seam than the type
	 * read would have covered logging and missed this.
	 */
	it("lets a ruling set it by amendment", async () => {
		const couple = await activeCouple();
		await couple.do.addEventTypeOption(SUB, {
			type_id: "task_completed",
			field_key: "quality",
			option: "went_over",
			label: "Went over the time",
		});
		const task = await couple.do.logEvent(DOM, {
			type: "task_assigned",
			metadata: { task_name: "Dishes", duration_ms: HOUR },
			subject: couple.subId,
			visibility: "shared",
		});

		advance(HOUR);
		const done = await couple.do.logEvent(SUB, {
			type: "task_completed",
			metadata: { task_id: task.metadata.task_id },
			subject: couple.subId,
			visibility: "shared",
		});

		advance(HOUR);
		const ruled = await couple.do.amend(DOM, {
			kind: "adjudication",
			target_event_id: done.id,
			patch: { quality: "went_over" },
		});

		expect(ruled.composite_metadata.quality).toBe("went_over");
		expect(ruled.pending).toBe(false);
	});

	it("still refuses a word nobody added", async () => {
		const couple = await withAddedAct();
		await expect(
			couple.do.logEvent(SUB, {
				type: "act",
				metadata: { act: "not_a_word" },
				subject: couple.subId,
				visibility: "shared",
			}),
		).rejects.toThrow(/not an allowed option/);
	});
});

describe("a pack bump keeps the couple's word and still delivers", () => {
	/**
	 * The real path: a second DO wakes over the same storage with the seeded
	 * version reset, so `ensureSeeded` re-runs its unconditional upsert exactly as
	 * a shipped bump would. Nothing here reaches into `event_type_options` —
	 * that it survives is the design, not a special case in the seeding.
	 */
	it("survives seedDefaults re-upserting every pack definition", async () => {
		const first = await withAddedAct();
		first.db
			.prepare(
				`UPDATE settings SET value = '0' WHERE key = 'event_types_version'`,
			)
			.run();

		const woken = await newCoupleDO(first.db);
		const types = await woken.do.listEventTypes(DOM);

		expect(enumField(types, "act", "act").options).toContain("aftercare_check");
	});

	/**
	 * The other half, which adopt-on-edit could not give: the bump's own change to
	 * the same type lands. Simulated by writing a newer `act` definition through
	 * the same upsert `seedDefaults` uses — the couple's overlay lives elsewhere,
	 * so the pack owns its definition outright and can move it freely.
	 */
	it("delivers a pack change to the very type the couple extended", async () => {
		const couple = await withAddedAct();
		const row = couple.db
			.prepare(`SELECT definition FROM event_types WHERE id = 'act'`)
			.get() as { definition: string };
		const next = JSON.parse(row.definition) as EventType;
		const act = next.metadata.act;
		if (act.kind !== "enum") throw new Error("act.act is not an enum");
		act.options.push("pack_new_act");
		next.note_prompt = "A newly shipped prompt.";
		couple.db
			.prepare(
				`INSERT INTO event_types (id, definition) VALUES (?, ?)
					ON CONFLICT(id) DO UPDATE SET definition = excluded.definition`,
			)
			.run("act", JSON.stringify(next));

		const options = await actOptions(couple);
		expect(options).toContain("pack_new_act");
		expect(options).toContain("aftercare_check");
		const types = await couple.do.listEventTypes(DOM);
		expect(types.find((t) => t.id === "act")?.note_prompt).toBe(
			"A newly shipped prompt.",
		);
	});

	/**
	 * And if the pack later ships the couple's word itself, the pack's copy wins —
	 * the option is the pack's now, so a bump that relabels it is not fighting a
	 * label typed before it existed. The overlay row stays, so nothing is lost if a
	 * later bump drops it again.
	 */
	it("yields position and copy to a pack that ships the same word", async () => {
		const couple = await withAddedAct();
		const row = couple.db
			.prepare(`SELECT definition FROM event_types WHERE id = 'act'`)
			.get() as { definition: string };
		const next = JSON.parse(row.definition) as EventType;
		const act = next.metadata.act;
		if (act.kind !== "enum") throw new Error("act.act is not an enum");
		act.options.push("aftercare_check");
		act.option_labels = {
			...act.option_labels,
			aftercare_check: "Aftercare, checked in on",
		};
		couple.db
			.prepare(`UPDATE event_types SET definition = ? WHERE id = 'act'`)
			.run(JSON.stringify(next));

		const field = enumField(await couple.do.listEventTypes(DOM), "act", "act");
		expect(field.options.filter((o) => o === "aftercare_check")).toHaveLength(
			1,
		);
		expect(field.option_labels?.aftercare_check).toBe(
			"Aftercare, checked in on",
		);
	});
});

describe("who may extend a field", () => {
	it("refuses a role the field's set_permission excludes", async () => {
		const couple = await activeCouple();
		// `journal_prompt.floor` is dom-set: the dom sets the floor a prompt is
		// answered at, so the sub may not widen the vocabulary of it either.
		await expect(
			couple.do.addEventTypeOption(SUB, {
				type_id: "journal_prompt",
				field_key: "floor",
				option: "private_note",
			}),
		).rejects.toThrow(/may not set/);
	});

	it("refuses a field that is not a list of options", async () => {
		const couple = await activeCouple();
		await expect(
			couple.do.addEventTypeOption(DOM, {
				type_id: "act",
				field_key: "session_id",
				option: "nope",
			}),
		).rejects.toThrow(/not a list of options/);
	});

	it("refuses a duplicate, pack-shipped or couple-added alike", async () => {
		const couple = await withAddedAct();
		for (const option of ["impact", "aftercare_check"]) {
			await expect(
				couple.do.addEventTypeOption(SUB, {
					type_id: "act",
					field_key: "act",
					option,
				}),
			).rejects.toThrow(/already exists/);
		}
	});

	it("refuses a token that is not lower snake case", async () => {
		const couple = await activeCouple();
		await expect(
			couple.do.addEventTypeOption(SUB, {
				type_id: "act",
				field_key: "act",
				option: "Aftercare Check",
			}),
		).rejects.toThrow(/lowercase/);
	});
});

describe("renaming changes the word, never the token", () => {
	it("relabels a couple-added option in place", async () => {
		const couple = await withAddedAct();
		await couple.do.logEvent(SUB, {
			type: "act",
			metadata: { act: "aftercare_check" },
			subject: couple.subId,
			visibility: "shared",
		});

		await couple.do.renameEventTypeOption(SUB, {
			type_id: "act",
			field_key: "act",
			option: "aftercare_check",
			label: "Checked in after",
		});

		const field = enumField(await couple.do.listEventTypes(DOM), "act", "act");
		expect(field.option_labels?.aftercare_check).toBe("Checked in after");
		// The logged event still carries the token it was logged with.
		const events = await couple.do.listEvents(DOM);
		expect(events[0]?.metadata.act).toBe("aftercare_check");
	});

	it("refuses to relabel a pack-shipped option", async () => {
		const couple = await activeCouple();
		await expect(
			couple.do.renameEventTypeOption(SUB, {
				type_id: "act",
				field_key: "act",
				option: "impact",
				label: "Impact play",
			}),
		).rejects.toThrow(/only a word you added/);
	});
});
