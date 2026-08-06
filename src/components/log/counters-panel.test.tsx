// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	adjustCounter: vi.fn(() => Promise.resolve({})),
	createCounter: vi.fn(() => Promise.resolve({})),
	deleteCounter: vi.fn(() => Promise.resolve({})),
	getCounterTrace: vi.fn(() => Promise.resolve({ rows: [] })),
	resetCounter: vi.fn(() => Promise.resolve({})),
	updateCounter: vi.fn(() => Promise.resolve({})),
}));

import { deleteCounter, resetCounter, updateCounter } from "#/lib/api.ts";
import type { VersionedAgreement } from "#/shared/agreements.ts";
import type { Counter } from "#/shared/counters.ts";
import type { Role } from "#/shared/roles.ts";
import { CountersPanel } from "./counters-panel.tsx";

/**
 * Destructive taps on a counter row (#93). A reset wipes a long-running tally
 * and nothing restores the value — the trace records it, but there is no undo
 * surface — so it takes the same two-tap inline confirm as delete rather than
 * firing on a single mis-tap.
 */

function counter(over: Partial<Counter> = {}): Counter {
	return {
		id: "chores",
		name: "Chores",
		valence: "neutral",
		target_direction: "floor",
		reset: "never",
		rungs: [],
		modify_permission: ["dom", "sub", "switch"],
		value: 42,
		updated_at: null,
		...over,
	};
}

function renderPanel(
	counters: Counter[],
	{
		agreements = [],
		selfRole = "dom" as Role | null,
	}: { agreements?: VersionedAgreement[]; selfRole?: Role | null } = {},
) {
	return render(
		<CountersPanel
			counters={counters}
			agreements={agreements}
			selfRole={selfRole}
			onChange={() => {}}
		/>,
	);
}

const click = (name: string | RegExp) =>
	fireEvent.click(screen.getByRole("button", { name }));

describe("counter reset confirmation", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(resetCounter).mockClear();
		vi.mocked(deleteCounter).mockClear();
	});

	it("does not reset on the first tap", () => {
		renderPanel([counter()]);
		click("Reset");
		expect(vi.mocked(resetCounter)).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Yes, reset" })).not.toBeNull();
	});

	it("resets on the second tap", async () => {
		renderPanel([counter()]);
		click("Reset");
		click("Yes, reset");
		await act(async () => {});
		expect(vi.mocked(resetCounter)).toHaveBeenCalledWith("chores");
	});

	it("cancelling drops the confirm without resetting", () => {
		renderPanel([counter()]);
		click("Reset");
		click("Cancel");
		expect(vi.mocked(resetCounter)).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Yes, reset" })).toBeNull();
		expect(screen.getByRole("button", { name: "Reset" })).not.toBeNull();
	});

	it("confirms only the row that was tapped", () => {
		renderPanel([counter(), counter({ id: "water", name: "Water" })]);
		fireEvent.click(screen.getAllByRole("button", { name: "Reset" })[0]);
		expect(screen.getAllByRole("button", { name: "Yes, reset" })).toHaveLength(
			1,
		);
		expect(screen.getAllByRole("button", { name: "Reset" })).toHaveLength(1);
	});

	it("opening the delete confirm closes a pending reset confirm", () => {
		renderPanel([counter()]);
		click("Reset");
		click("Delete");
		expect(screen.queryByRole("button", { name: "Yes, reset" })).toBeNull();
		expect(screen.getByRole("button", { name: "Yes, delete" })).not.toBeNull();
	});

	it("opening the reset confirm closes a pending delete confirm", () => {
		renderPanel([counter()]);
		click("Delete");
		click("Reset");
		expect(screen.queryByRole("button", { name: "Yes, delete" })).toBeNull();
		expect(screen.getByRole("button", { name: "Yes, reset" })).not.toBeNull();
	});
});

describe("counter delete confirmation", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(deleteCounter).mockClear();
	});

	it("deletes only on the second tap", async () => {
		renderPanel([counter()]);
		click("Delete");
		expect(vi.mocked(deleteCounter)).not.toHaveBeenCalled();
		click("Yes, delete");
		await act(async () => {});
		expect(vi.mocked(deleteCounter)).toHaveBeenCalledWith("chores");
	});
});

/**
 * Valence reaches a reader who can't see the tint (#148). The row is dense
 * enough that the cue has to be SR-only text rather than a glyph, so the test
 * asserts the text is present and adjacent to the value it qualifies.
 */
describe("counter valence without color", () => {
	afterEach(cleanup);

	it("names the valence next to the value", () => {
		renderPanel([
			counter({ id: "kept", name: "Kept", valence: "positive", value: 7 }),
			counter({ id: "missed", name: "Missed", valence: "negative", value: 2 }),
			counter({ id: "chores", name: "Chores", valence: "neutral", value: 42 }),
		]);
		expect(screen.getByText("7").textContent).toBe("7positive counter");
		expect(screen.getByText("2").textContent).toBe("2negative counter");
		expect(screen.getByText("42").textContent).toBe("42neutral counter");
	});
});

/**
 * The creator's pickers are Radix triggers — buttons, not form controls, so no
 * label can point at them with `htmlFor` (#148). They name the caption *and*
 * themselves, so the value they hold stays part of what is read back.
 */
describe("the counter creator's controls are named", () => {
	afterEach(cleanup);

	it("names each picker by its caption and its current value", () => {
		renderPanel([]);
		click("New counter");
		const kind = screen.getByRole("combobox", { name: "Type" });
		const valence = screen.getByRole("combobox", { name: "Valence" });
		// The caption is only half of it: each trigger also lists *itself*, which is
		// what keeps the chosen value in the announced name. `dom-accessibility-api`
		// drops a self-reference (it treats the traversal root as already visited)
		// and so computes the caption alone, hence asserting the wiring here rather
		// than a name a real screen reader would read as "Type, Tally".
		expect(kind.getAttribute("aria-labelledby")).toContain(
			kind.getAttribute("id"),
		);
		expect(valence.getAttribute("aria-labelledby")).toContain(
			valence.getAttribute("id"),
		);
	});

	it("gives the targets and the name field a label of their own", () => {
		renderPanel([]);
		click("New counter");
		expect(
			screen.getByRole("textbox", { name: "Counter name" }),
		).not.toBeNull();
		expect(
			screen.getByRole("spinbutton", { name: "Daily target" }),
		).not.toBeNull();
		expect(
			screen.getByRole("spinbutton", { name: "Weekly target" }),
		).not.toBeNull();
	});
});

/**
 * Rung authoring in the counter form (#193, ADR 0015).
 *
 * The gate is on writing, never on reading: the banner on Today shows both
 * partners the same ladder, because a ladder is a term the couple consented to.
 * What the gate must not do is *lose* anything — the partner who cannot edit the
 * rungs still edits the name beside them.
 */
describe("counter rungs", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(updateCounter).mockClear();
	});

	const TERM: VersionedAgreement = {
		id: "ag_ten",
		kind: "protocol",
		versions: [
			{ effective_from: 0, name: "Ten demerits", text: "…", retired: false },
		],
	};

	const withRung = counter({
		id: "demerits",
		name: "Demerits",
		rungs: [{ at: 10, agreement_ref: "ag_ten" }],
	});

	it("offers the ladder editor to the dom", () => {
		renderPanel([withRung], { agreements: [TERM], selfRole: "dom" });
		click("Edit");
		expect(screen.getByRole("button", { name: "Add rung" })).not.toBeNull();
	});

	it("withholds it from the sub, whom the ladder binds but who does not write it", () => {
		renderPanel([withRung], { agreements: [TERM], selfRole: "sub" });
		click("Edit");
		expect(screen.queryByRole("button", { name: "Add rung" })).toBeNull();
	});

	it("carries the rungs through an edit by the partner who cannot see them", async () => {
		// The failure this exists to prevent: a sub renaming a counter silently
		// stripping the ladder, because the form submits what it holds and the
		// hidden editor never seeded it.
		renderPanel([withRung], { agreements: [TERM], selfRole: "sub" });
		click("Edit");
		click("Save changes");
		await act(async () => {});
		expect(vi.mocked(updateCounter)).toHaveBeenCalledWith(
			"demerits",
			expect.objectContaining({
				rungs: [{ at: 10, agreement_ref: "ag_ten" }],
			}),
		);
	});

	it("shows the ladder in the counter's summary line", () => {
		renderPanel([withRung], { agreements: [TERM], selfRole: "sub" });
		expect(screen.getByText(/rungs at 10/)).not.toBeNull();
	});

	it("refuses to save a rung with no term, rather than announcing nothing", () => {
		renderPanel([withRung], { agreements: [TERM], selfRole: "dom" });
		click("Edit");
		click("Add rung");
		click("Save changes");
		expect(vi.mocked(updateCounter)).not.toHaveBeenCalled();
		expect(
			screen.getByText(/needs a whole number and an agreement/),
		).not.toBeNull();
	});
});
