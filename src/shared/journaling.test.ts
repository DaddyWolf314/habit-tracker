import { describe, expect, it } from "vitest";
import {
	isSelfDirected,
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
