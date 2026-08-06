// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/identity.ts", () => ({ hasIdentity: () => true }));
vi.mock("#/lib/api.ts", () => ({
	listEventTypes: vi.fn(() => Promise.resolve({ types: TYPES })),
	listEventTypeOptions: vi.fn(() => Promise.resolve({ options: MINE })),
	getRoles: vi.fn(() => Promise.resolve({ members: MEMBERS })),
	addEventTypeOption: vi.fn(() => Promise.resolve(TYPES[0])),
	renameEventTypeOption: vi.fn(() => Promise.resolve(TYPES[0])),
}));

import { addEventTypeOption, renameEventTypeOption } from "#/lib/api.ts";
import type { EventType, OptionAddition } from "#/shared/event-types.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { VocabularyView } from "./vocabulary-view.tsx";

/**
 * The vocabulary screen (#185, ADR 0014).
 *
 * Three things here are load-bearing and none of them are visible in the data,
 * so they are what these pin: a field you may not set is *absent* rather than
 * disabled, the pack's words carry no rename affordance, and the token a word
 * will be stored under is shown before it is minted — it is the one thing on
 * this screen a person cannot later fix by typing over it.
 */

const MEMBERS: RoleMember[] = [
	{ member_id: "m1", role: "sub", is_self: true },
	{ member_id: "m2", role: "dom", is_self: false },
];

const TYPES: EventType[] = [
	{
		id: "act",
		label: "Act",
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		journaling: false,
		awaiting: [],
		metadata: {
			act: {
				kind: "enum",
				options: ["impact", "aftercare_check"],
				option_labels: { impact: "Impact", aftercare_check: "Aftercare check" },
				label: "Act",
				required: false,
				set_permission: ["dom", "sub", "switch"],
			},
		},
	},
	{
		id: "journal_prompt",
		label: "Journal prompt",
		valence: "neutral",
		log_permission: ["dom", "switch"],
		subject_required: false,
		journaling: false,
		awaiting: [],
		metadata: {
			floor: {
				kind: "enum",
				options: ["sealed", "shared"],
				label: "Floor",
				required: false,
				// Dom-set: the sub must not be offered this list at all.
				set_permission: ["dom", "switch"],
			},
		},
	},
];

const MINE: OptionAddition[] = [
	{
		type_id: "act",
		field_key: "act",
		option: "aftercare_check",
		label: "Aftercare check",
	},
];

async function renderView(): Promise<void> {
	render(<VocabularyView />);
	await act(async () => {
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(cleanup);

describe("what the screen offers", () => {
	it("shows only fields this role may set", async () => {
		await renderView();
		expect(screen.getByText("Act")).toBeTruthy();
		// `journal_prompt.floor` is dom-set and this viewer is the sub, so the list
		// is not on the page at all — not shown disabled.
		expect(screen.queryByText("Floor")).toBeNull();
	});

	it("marks the couple's own words and offers rename on those alone", async () => {
		await renderView();
		expect(screen.getByText("yours")).toBeTruthy();
		// One rename button, for the one word that is theirs — the pack's `impact`
		// has none, because a bump keeps improving its copy.
		expect(screen.getAllByRole("button", { name: "Rename" })).toHaveLength(1);
	});
});

describe("adding a word", () => {
	it("previews the token before minting it, and sends both", async () => {
		await renderView();
		fireEvent.change(screen.getByPlaceholderText("Add a word"), {
			target: { value: "Rope play" },
		});
		expect(screen.getByText("Saved as rope_play.")).toBeTruthy();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Add" }));
		});
		expect(addEventTypeOption).toHaveBeenCalledWith({
			type_id: "act",
			field_key: "act",
			option: "rope_play",
			label: "Rope play",
		});
	});

	it("refuses a word already on the list", async () => {
		await renderView();
		fireEvent.change(screen.getByPlaceholderText("Add a word"), {
			target: { value: "Impact" },
		});
		expect(screen.getByText('"impact" is already on this list.')).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Add" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("refuses input with no word in it", async () => {
		await renderView();
		fireEvent.change(screen.getByPlaceholderText("Add a word"), {
			target: { value: "!!!" },
		});
		expect(
			screen.getByRole("button", { name: "Add" }).hasAttribute("disabled"),
		).toBe(true);
	});
});

describe("renaming a word", () => {
	it("sends the new label against the unchanged token", async () => {
		await renderView();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		});
		// The row says what stays put, because a rename looks like it might not.
		expect(screen.getByText("still logged as aftercare_check")).toBeTruthy();

		fireEvent.change(screen.getByDisplayValue("Aftercare check"), {
			target: { value: "Checked in after" },
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
		});

		expect(renameEventTypeOption).toHaveBeenCalledWith({
			type_id: "act",
			field_key: "act",
			option: "aftercare_check",
			label: "Checked in after",
		});
	});
});
