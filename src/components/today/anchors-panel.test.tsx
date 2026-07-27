// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AnchorView } from "#/shared/anchors.ts";
import { AnchorsPanel } from "./anchors-panel.tsx";

/**
 * The clocks, on Today since #88. "Trivial, disproportionately loved"
 * (`bootstrap.md:189`) — glance content, which is what Today is for.
 *
 * The ordering matters and is the reason this has a test: `AnchorsPanel` keeps
 * the two orgasm anchors adjacent because reading them together *is* the "sub
 * waits for the dom" Protocol's visibility surface (ADR 0003). Anything that
 * separated them would quietly remove the thing the panel is for.
 */

const anchor = (id: string, days: number | null): AnchorView =>
	({ anchor: id, since: null, elapsed_days: days }) as AnchorView;

describe("AnchorsPanel", () => {
	afterEach(cleanup);

	it("renders nothing when the couple has no anchors", () => {
		const { container } = render(<AnchorsPanel anchors={[]} />);
		expect(container.textContent).toBe("");
	});

	it("reads an elapsed count in days", () => {
		render(<AnchorsPanel anchors={[anchor("since_last_infraction", 12)]} />);
		expect(screen.getByText("12 days")).not.toBeNull();
	});

	it("shows a never-reset anchor as blank rather than zero", () => {
		// "0 days since" would assert something that never happened.
		render(<AnchorsPanel anchors={[anchor("since_last_infraction", null)]} />);
		expect(screen.getByText("—")).not.toBeNull();
	});

	it("keeps the dom's orgasm clock immediately after the sub's", () => {
		// ADR 0003's pairing: the two read as a pair or they read as nothing.
		render(
			<AnchorsPanel
				anchors={[
					anchor("since_last_orgasm", 3),
					anchor("since_last_check_in", 1),
					anchor("since_dom_last_orgasm", 9),
				]}
			/>,
		);
		const labels = [...document.querySelectorAll("li")].map((li) =>
			li.textContent?.replace(/\s+/g, " ").trim(),
		);
		const sub = labels.findIndex((l) => l?.includes("3 days"));
		const dom = labels.findIndex((l) => l?.includes("9 days"));
		expect(dom).toBe(sub + 1);
	});
});
