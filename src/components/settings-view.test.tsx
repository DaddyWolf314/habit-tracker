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
	dissolve: vi.fn(() => Promise.resolve({})),
	exportData: vi.fn(() => Promise.resolve({})),
}));

import { dissolve } from "#/lib/api.ts";
import { YourDataPanel } from "./settings-view.tsx";

/**
 * Dissolving ends the relationship for both partners, so it takes the house
 * two-tap inline confirm (#93) rather than a browser dialog. These pin the
 * behaviour the shared `InlineConfirm` has to preserve.
 */

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

describe("dissolving a space", () => {
	beforeEach(() => {
		vi.mocked(dissolve).mockClear();
	});
	afterEach(cleanup);

	function renderPanel() {
		render(<YourDataPanel dissolved={false} onDissolved={() => {}} />);
	}

	it("does not dissolve on the first tap", () => {
		renderPanel();
		click("Dissolve this space");
		expect(vi.mocked(dissolve)).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Yes, dissolve everything" }),
		).not.toBeNull();
	});

	it("dissolves on the second tap", async () => {
		renderPanel();
		click("Dissolve this space");
		click("Yes, dissolve everything");
		await act(async () => {});
		expect(vi.mocked(dissolve)).toHaveBeenCalled();
	});

	it("cancelling drops the confirm without dissolving", () => {
		renderPanel();
		click("Dissolve this space");
		click("Cancel");
		expect(vi.mocked(dissolve)).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Yes, dissolve everything" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Dissolve this space" }),
		).not.toBeNull();
	});

	it("offers nothing to dissolve once the space already is", () => {
		render(<YourDataPanel dissolved={true} onDissolved={() => {}} />);
		expect(
			screen.queryByRole("button", { name: "Dissolve this space" }),
		).toBeNull();
	});
});
