// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	ackRuleChanges: vi.fn(() => Promise.resolve({ ok: true })),
	createRule: vi.fn(() => Promise.resolve({})),
	deleteRule: vi.fn(() => Promise.resolve({ purged: true })),
	getRoles: vi.fn(() =>
		Promise.resolve({
			members: [{ member_id: "m1", role: "dom", is_self: true }],
			assignment: null,
			proposed_by: null,
			confirmed_by: [],
			active: true,
		}),
	),
	listCounters: vi.fn(() => Promise.resolve({ counters: [] })),
	listEventTypes: vi.fn(() => Promise.resolve({ types: [] })),
	listRuleChanges: vi.fn(() => Promise.resolve({ changes: [] })),
	listRuleHistory: vi.fn(() => Promise.resolve({ rules: [RULE] })),
	setRuleEnabled: vi.fn(() => Promise.resolve({})),
	updateRule: vi.fn(() => Promise.resolve({})),
}));

vi.mock("#/lib/identity.ts", () => ({ hasIdentity: () => true }));

import { deleteRule } from "#/lib/api.ts";
import type { VersionedRule } from "#/shared/rules.ts";
import { RulesView } from "./rules-view.tsx";

/**
 * Removing a rule is destructive and has no undo surface (#93), so it takes the
 * house two-tap inline confirm rather than firing on a single tap — the same
 * guard dissolve, retraction and counter delete already use.
 */

const RULE: VersionedRule = {
	id: "R1",
	origin: "custom",
	adopted: false,
	versions: [
		{
			effective_from: 0,
			condition: { type: "task_completed", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "points", by: 1 }],
			enabled: true,
		},
	],
};

async function renderRules() {
	render(<RulesView />);
	// The view loads its rules in an effect; let that settle before asserting.
	await act(async () => {});
}

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

describe("removing a rule", () => {
	beforeEach(() => {
		vi.mocked(deleteRule).mockClear();
	});
	afterEach(cleanup);

	it("does not remove on the first tap", async () => {
		await renderRules();
		click("Remove");
		expect(vi.mocked(deleteRule)).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Yes, remove" })).not.toBeNull();
	});

	it("removes on the second tap", async () => {
		await renderRules();
		click("Remove");
		click("Yes, remove");
		await act(async () => {});
		expect(vi.mocked(deleteRule)).toHaveBeenCalledWith("R1");
	});

	// `deleteRule` only purges a custom rule that never fired; a pack rule, or one
	// that has fired, collapses to a disable and stays in the list (ADR 0002). The
	// card is still mounted afterwards, so the confirm has to disarm itself or the
	// row sits armed and a stray tap re-fires the delete.
	it("disarms after a remove that collapsed to a disable", async () => {
		vi.mocked(deleteRule).mockResolvedValueOnce({ purged: false });
		await renderRules();
		click("Remove");
		click("Yes, remove");
		await act(async () => {});
		expect(screen.queryByRole("button", { name: "Yes, remove" })).toBeNull();
		expect(screen.getByRole("button", { name: "Remove" })).not.toBeNull();
	});

	it("cancelling drops the confirm without removing", async () => {
		await renderRules();
		click("Remove");
		click("Cancel");
		expect(vi.mocked(deleteRule)).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Yes, remove" })).toBeNull();
		expect(screen.getByRole("button", { name: "Remove" })).not.toBeNull();
	});
});
