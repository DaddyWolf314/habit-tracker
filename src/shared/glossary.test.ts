import { describe, expect, it } from "vitest";
import { defineTerms, GLOSSARY, type TermId } from "./glossary.ts";

/**
 * The app's words (#212 item 4).
 *
 * Copy is not worth asserting sentence by sentence — a wording fix would be a
 * test failure, which is how a copy file ends up with its tests deleted. What is
 * worth holding is the structure the call sites depend on, and one invariant in
 * particular: the key *is* the word, because a surface names a term by key and
 * `Define` builds "What's a <term>?" from the entry. If those two ever disagree,
 * a toggle asks about one word and answers about another.
 */
describe("GLOSSARY", () => {
	const ids = Object.keys(GLOSSARY) as TermId[];

	it("keys every entry by the word it defines", () => {
		for (const id of ids) expect(GLOSSARY[id].term).toBe(id);
	});

	it("defines every word it lists", () => {
		for (const id of ids)
			expect(GLOSSARY[id].definition.length).toBeGreaterThan(0);
	});

	it("covers the words #212 named as undefined in the product", () => {
		// The issue's list, with the two the UI calls something else: an *anchor* is
		// a "clock" on screen (CONTEXT §Counter / Timer / Anchor — "Clocks is the
		// UI's word"), and *timer* is never shown as a word at all, since the two
		// flavors are surfaced separately as countdowns and sessions. Defining the
		// model's word instead of the screen's would answer a question nobody asked.
		for (const id of [
			"counter",
			"streak",
			"clock",
			"rung",
			"countdown",
			"session",
			"waiver",
			"amendment",
			"adjudication",
			"response",
			"currency",
			"price",
		] as TermId[]) {
			expect(GLOSSARY[id]).toBeDefined();
		}
	});
});

describe("defineTerms", () => {
	it("returns entries in the order asked for", () => {
		// A reading order, not a set: "streak" only makes sense after "counter", so
		// the caller's order is the one that ships.
		expect(defineTerms(["streak", "counter"]).map((e) => e.term)).toEqual([
			"streak",
			"counter",
		]);
	});

	it("returns nothing for no terms", () => {
		expect(defineTerms([])).toEqual([]);
	});
});
