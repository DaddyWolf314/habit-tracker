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
	listEventTypes: vi.fn(() => Promise.resolve({ types: served })),
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

/** What `listEventTypes` answers with — swapped by the shared-vocabulary block. */
let served: EventType[] = TYPES;

async function renderView(): Promise<void> {
	render(<VocabularyView />);
	await act(async () => {
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	served = TYPES;
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

/**
 * Fields sharing a `vocabulary` are one list on this screen (ADR 0018).
 *
 * This is the bug as reported: the page listed **Activity twice**, because
 * `activity` is asked on both session events and the screen rendered one card
 * per field. The two cards were identical but for a small grey line, and worse
 * than redundant — a word added to one was absent from the other, so the couple
 * could start a session the app would then refuse to close.
 */
const ACTIVITY: EventType["metadata"][string] = {
	kind: "enum",
	options: ["service", "scene"],
	option_labels: { service: "Service", scene: "Scene" },
	label: "Activity",
	vocabulary: "activity",
	required: true,
	set_permission: ["dom", "sub", "switch"],
};

const SESSION_TYPES: EventType[] = [
	{
		id: "session_started",
		label: "Session started",
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: true,
		journaling: false,
		awaiting: [],
		metadata: { activity: ACTIVITY },
	},
	{
		id: "session_ended",
		label: "Session ended",
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: true,
		journaling: false,
		awaiting: [],
		metadata: { activity: ACTIVITY },
	},
];

describe("a shared vocabulary is one list", () => {
	beforeEach(() => {
		served = SESSION_TYPES;
	});

	it("lists Activity once, not once per event that asks it", async () => {
		await renderView();
		expect(screen.getAllByRole("heading", { name: "Activity" })).toHaveLength(
			1,
		);
		expect(screen.getAllByPlaceholderText("Add a word")).toHaveLength(1);
	});

	it("names every event the words are spoken on", async () => {
		// The card is no longer "on session started". Collapsing two lists into one
		// must not quietly drop where the second one was asked.
		await renderView();
		expect(
			screen.getByText("on session started and session ended"),
		).toBeTruthy();
	});

	it("addresses the write to one site and lets the server fan it out", async () => {
		await renderView();
		fireEvent.change(screen.getByPlaceholderText("Add a word"), {
			target: { value: "Yoga" },
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Add" }));
		});

		// One call, not one per site: the DO resolves the vocabulary through the
		// same `vocabularySites` this screen grouped by, so a client that forgot
		// half the fan-out is not a shape this API can be used in.
		expect(addEventTypeOption).toHaveBeenCalledTimes(1);
		expect(addEventTypeOption).toHaveBeenCalledWith({
			type_id: "session_started",
			field_key: "activity",
			option: "yoga",
			label: "Yoga",
		});
	});

	it("still separates lists that share no vocabulary", async () => {
		// `act` and `floor` declare none, so they stay their own cards — grouping
		// keys on the declared id, never on two enums happening to look alike.
		served = TYPES;
		await renderView();
		expect(screen.getByText("on act")).toBeTruthy();
	});
});
