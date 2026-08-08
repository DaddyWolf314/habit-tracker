import { describe, expect, it } from "vitest";
import { GLOSSARY, type TermId } from "./glossary.ts";

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
		// The issue's eleven, one of them re-spelled: an *anchor* is a "clock" on
		// screen (CONTEXT §Counter / Timer / Anchor — "Clocks is the UI's word"), so
		// defining the model's word instead of the screen's would answer a question
		// nobody asked.
		//
		// *timer* stays, and is not covered by countdown and session. Those are the
		// two flavors, surfaced separately on Today; the umbrella word is what the
		// Rules screen actually ships — "your counters and timers", "Add timer
		// condition" — so a reader meets it there with the flavors nowhere in sight.
		for (const id of [
			"counter",
			"streak",
			"clock",
			"rung",
			"timer",
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

// The reading-order and empty-list behaviour that `defineTerms` used to hold is
// tested on `Define` now, which is where it lives since the helper — a one-caller
// `ids.map((id) => GLOSSARY[id])` — was inlined.
