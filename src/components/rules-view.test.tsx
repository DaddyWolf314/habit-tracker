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
	listAgreements: vi.fn(() => Promise.resolve({ agreements: AGREEMENTS })),
	listCounters: vi.fn(() => Promise.resolve({ counters: [] })),
	listEventTypes: vi.fn(() => Promise.resolve({ types: TYPES })),
	listRuleHistory: vi.fn(() => Promise.resolve({ rules: [RULE] })),
	setRuleEnabled: vi.fn(() => Promise.resolve({})),
	updateRule: vi.fn(() => Promise.resolve({})),
}));

vi.mock("#/lib/identity.ts", () => ({ hasIdentity: () => true }));

import { deleteRule } from "#/lib/api.ts";
import type { VersionedAgreement } from "#/shared/agreements.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { VersionedRule } from "#/shared/rules.ts";
import { RulesView } from "./rules-view.tsx";

/**
 * Removing a rule is destructive and has no undo surface (#93), so it takes the
 * house two-tap inline confirm rather than firing on a single tap — the same
 * guard dissolve, retraction and counter delete already use.
 */

const AGREEMENTS: VersionedAgreement[] = [
	{
		id: "ag_1",
		kind: "ritual",
		versions: [
			{ effective_from: 0, name: "morning kneel", text: "", retired: false },
		],
	},
	{
		id: "ag_2",
		kind: "protocol",
		versions: [
			{
				effective_from: 0,
				name: "ask before you come",
				text: "",
				retired: false,
			},
		],
	},
];

/** A type whose ref cites the corpus, narrowed to one kind. */
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

/**
 * The other side of the equality (#121, user story 33). The composer picks an
 * Agreement when logging; if a rule condition stayed a text box the dom would
 * hand-type an id here against a picked one there — reproducing exactly the
 * silent-mismatch failure #114 named, one layer up.
 */
describe("a rule condition on a citing ref", () => {
	afterEach(cleanup);

	// Every control in the editor now carries an accessible name (#148), so the
	// rows are addressed by name rather than by position — a reordered form no
	// longer silently retargets these.
	async function openConditionOn(typeId: string) {
		await renderRules();
		fireEvent.click(screen.getByRole("button", { name: "New rule" }));
		fireEvent.change(
			screen.getByRole("combobox", { name: "When this happens" }),
			{ target: { value: typeId } },
		);
		fireEvent.click(screen.getByRole("button", { name: /add condition/i }));
		fireEvent.change(
			screen.getByRole("combobox", { name: "Condition 1 key" }),
			{
				target: { value: "ritual_id" },
			},
		);
	}

	it("offers the corpus rather than a text box", async () => {
		await openConditionOn("ritual_completed");

		const labels = screen
			.getAllByRole("option")
			.map((o) => o.textContent)
			.filter(Boolean);
		expect(labels).toContain("morning kneel");
	});

	it("narrows to the kind the field names", async () => {
		// A ritual condition must not offer the couple's protocols, for the same
		// reason the composer doesn't offer their limits.
		await openConditionOn("ritual_completed");

		const labels = screen.getAllByRole("option").map((o) => o.textContent);
		expect(labels).not.toContain("ask before you come");
	});
});

/**
 * The revision list is a disclosure (#148): the button's own text is a count,
 * so without `aria-expanded` nothing tells a screen reader it toggles anything.
 */
describe("the revision-history disclosure", () => {
	afterEach(cleanup);

	it("flips aria-expanded and names the list it reveals", async () => {
		await renderRules();
		const toggle = screen.getByRole("button", { name: /revision/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");

		const listId = toggle.getAttribute("aria-controls") ?? "";
		expect(document.getElementById(listId)).toBeNull();

		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(document.getElementById(listId)).not.toBeNull();
	});
});
