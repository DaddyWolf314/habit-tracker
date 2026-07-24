import { describe, expect, it } from "vitest";
import {
	isSelfDirected,
	openPromptViews,
	type PromptCountdown,
	type PromptEvent,
	pairsWith,
	promptFloor,
	promptRef,
	satisfiesAssignment,
	satisfiesFloor,
} from "./journaling.ts";
import type { MetadataValue, Visibility } from "./roles.ts";

/**
 * Pairing and floor satisfaction as derived outcomes (ADR 0001), in the style of
 * `timers.test.ts` / `streaks.test.ts`: we assert *whether an assignment is
 * satisfied*, never how the check is computed.
 */

const prompt = (over: { prompt_id?: string; floor?: string } = {}) => {
	const metadata: Record<string, MetadataValue> = {};
	if (over.prompt_id !== undefined) metadata.prompt_id = over.prompt_id;
	if (over.floor !== undefined) metadata.floor = over.floor;
	return { metadata };
};

const answer = (visibility: Visibility, prompt_id?: string) => {
	const metadata: Record<string, MetadataValue> = {};
	if (prompt_id !== undefined) metadata.prompt_id = prompt_id;
	return { visibility, metadata };
};

describe("promptRef / promptFloor — reading the pairing fields", () => {
	it("reads a string prompt_id, and undefined when absent or non-string", () => {
		expect(promptRef(prompt({ prompt_id: "p1" }))).toBe("p1");
		expect(promptRef(prompt())).toBeUndefined();
		expect(promptRef({ metadata: { prompt_id: 7 } })).toBeUndefined();
	});

	it("treats an empty-string prompt_id as no ref at all", () => {
		// A ref that names nothing pairs with nothing — an empty-ref entry must
		// not "answer" an empty-ref prompt, and is self-directed like any refless
		// entry.
		expect(promptRef(prompt({ prompt_id: "" }))).toBeUndefined();
		expect(isSelfDirected(answer("shared", ""))).toBe(true);
		expect(pairsWith(answer("shared", ""), prompt({ prompt_id: "" }))).toBe(
			false,
		);
	});

	it("reads a sealed/shared floor, and undefined for absent, secret, or junk", () => {
		expect(promptFloor(prompt({ floor: "sealed" }))).toBe("sealed");
		expect(promptFloor(prompt({ floor: "shared" }))).toBe("shared");
		expect(promptFloor(prompt())).toBeUndefined();
		// secret is never a valid floor.
		expect(promptFloor(prompt({ floor: "secret" }))).toBeUndefined();
		expect(promptFloor(prompt({ floor: "loud" }))).toBeUndefined();
	});
});

describe("pairing — same prompt_id links question and answer", () => {
	it("an entry echoing the prompt's id pairs with it", () => {
		expect(pairsWith(answer("shared", "p1"), prompt({ prompt_id: "p1" }))).toBe(
			true,
		);
	});

	it("a different id does not pair", () => {
		expect(pairsWith(answer("shared", "p2"), prompt({ prompt_id: "p1" }))).toBe(
			false,
		);
	});

	it("a self-directed entry (no prompt_id) pairs with nothing and is flagged", () => {
		expect(isSelfDirected(answer("secret"))).toBe(true);
		expect(pairsWith(answer("secret"), prompt({ prompt_id: "p1" }))).toBe(
			false,
		);
	});
});

describe("satisfiesFloor — the credit gradient secret < sealed < shared", () => {
	it("shared clears every floor", () => {
		expect(satisfiesFloor("shared", "shared")).toBe(true);
		expect(satisfiesFloor("shared", "sealed")).toBe(true);
	});

	it("sealed clears a sealed floor but not a shared floor", () => {
		expect(satisfiesFloor("sealed", "sealed")).toBe(true);
		expect(satisfiesFloor("sealed", "shared")).toBe(false);
	});

	it("secret clears nothing — not even a floorless prompt", () => {
		expect(satisfiesFloor("secret", "sealed")).toBe(false);
		expect(satisfiesFloor("secret", "shared")).toBe(false);
		expect(satisfiesFloor("secret", null)).toBe(false);
	});

	it("a floorless prompt is cleared by any non-secret answer", () => {
		expect(satisfiesFloor("shared", null)).toBe(true);
		expect(satisfiesFloor("sealed", undefined)).toBe(true);
	});
});

describe("satisfiesAssignment — pairing AND clearing the floor", () => {
	it("an at-or-above-floor answer satisfies (closes the assignment)", () => {
		const p = prompt({ prompt_id: "p1", floor: "sealed" });
		expect(satisfiesAssignment(answer("sealed", "p1"), p)).toBe(true);
		expect(satisfiesAssignment(answer("shared", "p1"), p)).toBe(true);
	});

	it("a below-floor answer pairs but does NOT satisfy — the assignment stays unmet", () => {
		const p = prompt({ prompt_id: "p1", floor: "shared" });
		// A sealed answer to a shared-floor prompt: it is the sub's right to log it,
		// but it does not discharge the assignment (which then expires unmet).
		expect(pairsWith(answer("sealed", "p1"), p)).toBe(true);
		expect(satisfiesAssignment(answer("sealed", "p1"), p)).toBe(false);
	});

	it("a paired secret answer never satisfies (secret is inert / uncredited)", () => {
		const p = prompt({ prompt_id: "p1", floor: "sealed" });
		expect(satisfiesAssignment(answer("secret", "p1"), p)).toBe(false);
		// Even against a floorless prompt.
		expect(
			satisfiesAssignment(answer("secret", "p1"), prompt({ prompt_id: "p1" })),
		).toBe(false);
	});

	it("an unpaired answer never satisfies, whatever its visibility", () => {
		const p = prompt({ prompt_id: "p1", floor: "sealed" });
		expect(satisfiesAssignment(answer("shared", "p2"), p)).toBe(false);
		expect(satisfiesAssignment(answer("shared"), p)).toBe(false);
	});
});

describe("openPromptViews — the answer picker's outstanding prompts (#102)", () => {
	const countdown = (over: Partial<PromptCountdown> = {}): PromptCountdown => ({
		match: { prompt_id: "p1" },
		opened_by: "e1",
		deadline_at: 1000,
		expired: false,
		...over,
	});
	const promptEvent = (over: Partial<PromptEvent> = {}): PromptEvent => ({
		id: "e1",
		subject: "sub-1",
		note: "What are you grateful for?",
		metadata: { prompt_id: "p1", floor: "sealed" },
		...over,
	});

	it("joins a countdown to its prompt by opened_by and shapes the view", () => {
		expect(openPromptViews([countdown()], [promptEvent()], "sub-1")).toEqual([
			{
				prompt_id: "p1",
				question: "What are you grateful for?",
				floor: "sealed",
				deadline_at: 1000,
				paused: false,
				expired: false,
			},
		]);
	});

	it("falls back to the prompt_id ref for a pre-#102 timer with no opened_by", () => {
		const views = openPromptViews(
			[countdown({ opened_by: undefined })],
			[promptEvent()],
			"sub-1",
		);
		expect(views).toHaveLength(1);
		expect(views[0].question).toBe("What are you grateful for?");
	});

	it("only poses prompts assigned to the caller", () => {
		expect(openPromptViews([countdown()], [promptEvent()], "dom-1")).toEqual(
			[],
		);
	});

	it("drops a countdown whose prompt can't be resolved or whose ref is empty", () => {
		// No prompt event to pose the question from.
		expect(openPromptViews([countdown()], [], "sub-1")).toEqual([]);
		// An empty ref names nothing, so nothing could ever answer it.
		expect(
			openPromptViews(
				[countdown({ match: { prompt_id: "" } })],
				[promptEvent()],
				"sub-1",
			),
		).toEqual([]);
	});

	it("carries paused and expired countdown state into the view", () => {
		const views = openPromptViews(
			[
				countdown({ paused_at: 500 }),
				countdown({
					match: { prompt_id: "p2" },
					opened_by: "e2",
					expired: true,
				}),
			],
			[promptEvent(), promptEvent({ id: "e2", metadata: { prompt_id: "p2" } })],
			"sub-1",
		);
		expect(views.map((v) => [v.paused, v.expired])).toEqual([
			[true, false],
			[false, true],
		]);
		// A floorless prompt reads as null, not undefined (it must serialize).
		expect(views[1].floor).toBeNull();
	});
});
