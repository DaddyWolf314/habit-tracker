// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FirstRunStep } from "#/shared/first-run.ts";
import { FirstRunPanel } from "./first-run-panel.tsx";

/**
 * The first-run floor (#212).
 *
 * The load-bearing property is a *negative* one: this panel must never claim
 * anything about what has or has not been logged. It renders while the viewer
 * can see no events, and that is viewer-dependent — a partner's `secret` entries
 * are omitted from `listEvents` entirely (ADR 0001) — so "nothing has happened
 * yet" would be a false claim about the couple's record shown to the person
 * least able to check it.
 */

/** Renders inside a router, since each step points somewhere. */
function renderPanel(step: FirstRunStep) {
	const root = createRootRoute({
		component: () => <FirstRunPanel step={step} />,
	});
	const router = createRouter({
		routeTree: root.addChildren(
			["/", "/agreements", "/log"].map((path) =>
				createRoute({
					getParentRoute: () => root,
					path,
					component: () => null,
				}),
			),
		),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return render(<RouterProvider router={router as never} />);
}

describe("FirstRunPanel", () => {
	afterEach(cleanup);

	it("leaves saying what Today is to the page's lead sentence", async () => {
		// This panel used to open by explaining the screen, because the page had no
		// lead sentence. #212 item 3 gave it one, so that moved: it is a fact about
		// Today, true whether or not the couple has started, and this floor is keyed
		// on an empty log. Asserted as an absence so the two cannot both carry it —
		// which would put the same paragraph twice on the one screen it opens on.
		renderPanel("write");
		expect(await screen.findByText(/Getting started/i)).not.toBeNull();
		expect(screen.queryByText(/the day's slice/i)).toBeNull();
	});

	it("accounts for the seeded counter rather than leaving it unexplained", async () => {
		// The reason this panel exists: Today is not blank on a fresh install, it
		// shows one counter the couple never created. Saying nothing about it is
		// what makes it read as "the app is already tracking something about you".
		renderPanel("write");
		expect(
			await screen.findByText(/ships with the app so there's something/i),
		).not.toBeNull();
	});

	it("sends an empty corpus to Agreements", async () => {
		renderPanel("write");
		expect(await screen.findByText(/start with something you've agreed/i));
		const link = await screen.findByRole("link", { name: "Agreements" });
		expect(link.getAttribute("href")).toBe("/agreements");
	});

	it("names the control that turns a ritual into a target", async () => {
		// "Track this" is the exact button label on the Agreements screen; a
		// paraphrase here would send someone looking for a control by a name it
		// does not have.
		renderPanel("track");
		expect(await screen.findByText("Track this")).not.toBeNull();
	});

	it("sends a wired-up couple to the log", async () => {
		renderPanel("log");
		const link = await screen.findByRole("link", { name: /the log/i });
		expect(link.getAttribute("href")).toBe("/log");
	});

	it("never claims anything about what has been logged", async () => {
		// The property the whole panel is phrased around — asserted on every step,
		// since a reword of any one of them could reintroduce it.
		for (const step of ["write", "track", "log"] as FirstRunStep[]) {
			cleanup();
			const { container } = renderPanel(step);
			// Waits for the router to paint before reading the whole panel's text;
			// the heading is the one string every step shares.
			await screen.findByText(/Getting started/i);
			expect(container.textContent).not.toMatch(
				/nothing has happened|haven't logged|no events|nothing logged/i,
			);
		}
	});
});
