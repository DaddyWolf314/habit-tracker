import { describe, expect, it } from "vitest";
import type { Amendment } from "./amendments.ts";
import {
	isAnswered,
	openConversationFlags,
	raisesConversationFlag,
} from "./conversations.ts";
import type { EventView } from "./events.ts";

/**
 * The R18 fold (ADR 0007). What these tests are really pinning is the *ending*:
 * the flag closes on the partner's response and on nothing else — not on time,
 * not on the author's own words, not on a ruling.
 */

function event(over: Partial<EventView> = {}): EventView {
	return {
		id: "e1",
		type: "check_in",
		actor: "sub-1",
		occurred_at: 1_000,
		logged_at: 1_000,
		metadata: {},
		visibility: "shared",
		amendments: [],
		composite_metadata: { mood: 2, flag: "wants_conversation" },
		pending: false,
		retracted: false,
		...over,
	};
}

function amendment(over: Partial<Amendment> = {}): Amendment {
	return {
		id: "a1",
		target_event_id: "e1",
		actor: "dom-1",
		created_at: 2_000,
		kind: "response",
		note: "let's talk tonight",
		...over,
	} as Amendment;
}

describe("raisesConversationFlag", () => {
	it("matches a check-in carrying wants_conversation", () => {
		expect(raisesConversationFlag(event())).toBe(true);
	});

	it("ignores a check-in with no flag", () => {
		expect(
			raisesConversationFlag(event({ composite_metadata: { mood: 4 } })),
		).toBe(false);
	});

	it("ignores the flag on another event type", () => {
		// R18 conditions on the type as well as the key; so does this.
		expect(raisesConversationFlag(event({ type: "infraction" }))).toBe(false);
	});
});

describe("isAnswered", () => {
	it("is closed by the partner's response", () => {
		expect(isAnswered(event({ amendments: [amendment()] }))).toBe(true);
	});

	it("is not closed by the author's own note", () => {
		// Adding your own context is not the other person replying.
		const own = amendment({ kind: "note_appended", actor: "sub-1" });
		expect(isAnswered(event({ amendments: [own] }))).toBe(false);
	});

	it("is not closed by a ruling", () => {
		const ruling = amendment({
			kind: "adjudication",
			patch: { mood: 3 },
		} as Partial<Amendment>);
		expect(isAnswered(event({ amendments: [ruling] }))).toBe(false);
	});

	it("is not closed by a response the author somehow authored themselves", () => {
		// validateResponse refuses this at the write path; the fold does not rely
		// on that to be right about whose reply closes whose ask.
		const self = amendment({ actor: "sub-1" });
		expect(isAnswered(event({ amendments: [self] }))).toBe(false);
	});
});

describe("openConversationFlags", () => {
	it("carries the check-in the reply is aimed at", () => {
		const flags = openConversationFlags([event({ note: "rough week" })]);
		expect(flags).toEqual([
			{
				event_id: "e1",
				actor: "sub-1",
				occurred_at: 1_000,
				note: "rough week",
				mood: 2,
			},
		]);
	});

	it("drops a flag once the partner has responded", () => {
		expect(
			openConversationFlags([event({ amendments: [amendment()] })]),
		).toEqual([]);
	});

	it("drops a retracted check-in", () => {
		// Withdrawing the event withdraws the ask; nothing can respond to it now.
		expect(openConversationFlags([event({ retracted: true })])).toEqual([]);
	});

	it("never expires an old flag", () => {
		// The whole point of ADR 0007: only a person ends a conversation, so an ask
		// from a year ago is still an ask.
		const ancient = event({ occurred_at: 1, logged_at: 1 });
		expect(openConversationFlags([ancient])).toHaveLength(1);
	});

	it("puts the longest-waiting ask first", () => {
		const flags = openConversationFlags([
			event({ id: "new", occurred_at: 9_000 }),
			event({ id: "old", occurred_at: 2_000 }),
		]);
		expect(flags.map((f) => f.event_id)).toEqual(["old", "new"]);
	});

	it("reads a missing mood as null rather than inventing one", () => {
		const flags = openConversationFlags([
			event({ composite_metadata: { flag: "wants_conversation" } }),
		]);
		expect(flags[0].mood).toBeNull();
	});
});
