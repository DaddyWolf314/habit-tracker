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
	renameRule: vi.fn(() => Promise.resolve({})),
	setRuleEnabled: vi.fn(() => Promise.resolve({})),
	updateRule: vi.fn(() => Promise.resolve({})),
}));

vi.mock("#/lib/identity.ts", () => ({ hasIdentity: () => true }));

import {
	deleteRule,
	listRuleHistory,
	renameRule,
	updateRule,
} from "#/lib/api.ts";
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
	// A number field, so the editor's comparison operator (ADR 0011) has
	// something to attach to.
	{
		id: "check_in",
		label: "Check-in",
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {
			mood: {
				kind: "number",
				label: "Mood",
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

/** A rule renamed once — two revisions, each carrying the name of its own moment. */
const RENAMED: VersionedRule = {
	id: "custom-late-check-in",
	origin: "custom",
	adopted: false,
	versions: [
		{
			effective_from: 0,
			name: "Late check-in",
			condition: { type: "ritual_completed", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "points", by: 1 }],
			enabled: true,
		},
		{
			effective_from: 1_000,
			name: "Tardy check-in",
			condition: { type: "ritual_completed", metadata: {} },
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

/**
 * A rule carries a name (#150, ADR 0009). The issue's symptom was the editor
 * heading reading "Edit custom-late-check-in" — but the deeper requirement is the
 * one the effective-dated name buys: renaming a rule must not rewrite what the
 * revision history says it used to be called.
 */
describe("a rule's name", () => {
	afterEach(cleanup);

	async function renderRenamed() {
		vi.mocked(listRuleHistory).mockResolvedValueOnce({ rules: [RENAMED] });
		await renderRules();
	}

	it("heads the card, over the plain-language reading of what it does", async () => {
		await renderRenamed();
		expect(screen.getByText("Tardy check-in")).not.toBeNull();
		expect(screen.getByText(/when Ritual completed is logged/)).not.toBeNull();
	});

	it("names each past revision as it stood then, not as it stands now", async () => {
		await renderRenamed();
		fireEvent.click(screen.getByRole("button", { name: /revision/ }));
		// Both names are on screen: the old revision keeps the old wording, which is
		// the whole reason the name versions with the definition rather than sitting
		// on the identity row.
		expect(screen.getAllByText(/Late check-in/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Tardy check-in/).length).toBeGreaterThan(0);
	});

	it("heads the editor with the name rather than the stable id", async () => {
		await renderRenamed();
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		expect(
			screen.getByRole("heading", { name: "Edit Tardy check-in" }),
		).not.toBeNull();
		expect(screen.queryByText(/Edit custom-late-check-in/)).toBeNull();
	});

	// The editor's name box is offered on an edit, not only on a create — a rule
	// you cannot rename is the issue only half fixed.
	it("sends a rename as an ordinary edit, leaving the id alone", async () => {
		vi.mocked(updateRule).mockClear();
		await renderRenamed();
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Overdue check-in" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Review rule" }));
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await act(async () => {});
		expect(vi.mocked(updateRule)).toHaveBeenCalledWith(
			"custom-late-check-in",
			expect.objectContaining({ name: "Overdue check-in" }),
		);
	});

	// A rule that predates naming still has to render. The de-slug is the floor,
	// not the strategy (#150) — RULE below carries no name on any revision.
	it("falls back to a de-slugged id when no revision carries a name", async () => {
		await renderRules();
		expect(screen.getByRole("heading", { name: "Rules" })).not.toBeNull();
		expect(screen.getAllByText("R1").length).toBeGreaterThan(0);
	});
});

/**
 * Timer wiring is "advanced — view only" (#64): the structured picker has no way
 * to represent `open_timer`/`close_timer`, so those rules never reach the editor.
 * That left them stuck with their ids as names, which is the whole of #150 — so
 * the *name* axis is separated from the *effects* axis and only the latter stays
 * read-only.
 */
describe("renaming an advanced rule", () => {
	afterEach(cleanup);

	/** R15 — opens the session stopwatch. Nothing the picker can draw. */
	const ADVANCED: VersionedRule = {
		id: "R15",
		origin: "pack",
		adopted: false,
		versions: [
			{
				effective_from: 0,
				name: "Session starts the stopwatch",
				condition: { type: "ritual_completed", metadata: {} },
				effects: [
					{
						verb: "open_timer",
						timer: "session_stopwatch",
						match_on: { session_id: "session_id" },
						tag_from: "activity",
					},
				],
				enabled: true,
			},
		],
	};

	async function renderAdvanced() {
		vi.mocked(renameRule).mockClear();
		vi.mocked(updateRule).mockClear();
		vi.mocked(listRuleHistory).mockResolvedValueOnce({ rules: [ADVANCED] });
		await renderRules();
	}

	it("offers Rename where it withholds Edit", async () => {
		await renderAdvanced();
		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
		expect(screen.getByRole("button", { name: "Rename" })).not.toBeNull();
	});

	// The name box opens seeded, so the author corrects a name rather than
	// retyping one — and a blank submission is refused rather than clearing it.
	it("seeds the box with the current name and refuses a blank one", async () => {
		await renderAdvanced();
		click("Rename");
		const box = screen.getByLabelText("Name") as HTMLInputElement;
		expect(box.value).toBe("Session starts the stopwatch");
		fireEvent.change(box, { target: { value: "  " } });
		expect(
			(screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	// A name and only a name goes over the wire. The screen cannot render this
	// rule's effects, so it must never be the thing that sends them back.
	it("sends the name alone, never a definition it cannot render", async () => {
		await renderAdvanced();
		click("Rename");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Stopwatch starts" },
		});
		click("Save name");
		await act(async () => {});
		expect(vi.mocked(renameRule)).toHaveBeenCalledWith(
			"R15",
			"Stopwatch starts",
		);
		expect(vi.mocked(updateRule)).not.toHaveBeenCalled();
	});

	it("cancelling closes the box without renaming", async () => {
		await renderAdvanced();
		click("Rename");
		click("Cancel");
		expect(vi.mocked(renameRule)).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("Name")).toBeNull();
	});
});

/**
 * The two clause forms ADR 0011 added. Both are authored through the same live
 * preview the rules screen and the trace chain read, so these assert the
 * sentence rather than the payload — if the preview says it, the builder that
 * saves it produced it.
 */
describe("authoring the ADR 0011 clauses", () => {
	afterEach(cleanup);

	async function openEditorOn(typeId: string) {
		await renderRules();
		fireEvent.click(screen.getByRole("button", { name: "New rule" }));
		fireEvent.change(
			screen.getByRole("combobox", { name: "When this happens" }),
			{ target: { value: typeId } },
		);
	}

	it("offers a comparison operator on a number field", async () => {
		await openEditorOn("check_in");
		fireEvent.click(screen.getByRole("button", { name: /add condition/i }));
		fireEvent.change(
			screen.getByRole("combobox", { name: "Condition 1 key" }),
			{
				target: { value: "mood" },
			},
		);
		const op = screen.getByRole("combobox", { name: "Condition 1 comparison" });
		expect(
			[...op.querySelectorAll("option")].map((o) => o.textContent),
		).toEqual(["is", "is under", "is at most", "is over", "is at least"]);
	});

	it("gives a non-number field no operator to pick", async () => {
		// A comparison on a ref is one the server would refuse; the form never
		// offers it rather than reporting it after a save.
		await openEditorOn("ritual_completed");
		fireEvent.click(screen.getByRole("button", { name: /add condition/i }));
		fireEvent.change(
			screen.getByRole("combobox", { name: "Condition 1 key" }),
			{
				target: { value: "ritual_id" },
			},
		);
		expect(
			screen.queryByRole("combobox", { name: "Condition 1 comparison" }),
		).toBeNull();
	});

	it("previews a comparison in the couple's voice", async () => {
		await openEditorOn("check_in");
		fireEvent.click(screen.getByRole("button", { name: /add condition/i }));
		fireEvent.change(
			screen.getByRole("combobox", { name: "Condition 1 key" }),
			{
				target: { value: "mood" },
			},
		);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Condition 1 comparison" }),
			{ target: { value: "lte" } },
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Condition 1 value" }),
			{
				target: { value: "2" },
			},
		);
		expect(screen.getByText(/Mood is 2 or less/)).toBeTruthy();
	});

	it("previews an ambient clause as a trailing 'while'", async () => {
		await openEditorOn("check_in");
		fireEvent.click(
			screen.getByRole("button", { name: /add timer condition/i }),
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Timer 1" }), {
			target: { value: "denial_period" },
		});
		expect(screen.getByText(/while a denial period is running/)).toBeTruthy();
	});

	it("previews the negated clause too", async () => {
		await openEditorOn("check_in");
		fireEvent.click(
			screen.getByRole("button", { name: /add timer condition/i }),
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Timer 1" }), {
			target: { value: "session_stopwatch" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: "Timer 1 state" }), {
			target: { value: "not_running" },
		});
		expect(
			screen.getByText(/while no session stopwatch is running/),
		).toBeTruthy();
	});

	it("ignores a timer row with nothing picked", async () => {
		// An empty row is an unfinished thought, not a clause — the same rule the
		// condition rows follow.
		await openEditorOn("check_in");
		fireEvent.click(
			screen.getByRole("button", { name: /add timer condition/i }),
		);
		// Matched against the preview's trailing clause, not the fieldset legend
		// ("Only while… (optional timers)"), which is always on screen.
		expect(screen.queryByText(/, while /)).toBeNull();
	});
});
