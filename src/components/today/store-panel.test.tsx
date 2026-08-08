// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Counter } from "#/shared/counters.ts";
import type { VersionedRewardItem } from "#/shared/rewards.ts";
import { StorePanel } from "./store-panel.tsx";

/**
 * The store's state half on Today (#194, ADR 0017), and what it says about
 * itself (#212 item 2).
 *
 * The panel lists names and prices and stops there, so the fact that decides
 * whether a row is here — the **counter** the price is measured against — never
 * appears. Each score is its own counter (ADR 0015), so a couple with two
 * currencies is the ordinary case and "why is this one here" genuinely has more
 * than one answer.
 */

const counter = (id: string, name: string, value: number): Counter =>
	({
		id,
		name,
		valence: "positive",
		target_direction: "floor",
		reset: "never",
		rungs: [],
		modify_permission: ["dom", "sub", "switch"],
		value,
		updated_at: null,
	}) as Counter;

const item = (
	id: string,
	name: string,
	currency: string,
	price: number,
): VersionedRewardItem => ({
	id,
	versions: [
		{
			effective_from: 0,
			name,
			terms: "",
			currency,
			price,
			requires_grant: true,
			retired: false,
		},
	],
});

/** Renders inside a router, since the panel links out to the store. */
function renderPanel(items: VersionedRewardItem[], counters: Counter[]) {
	const root = createRootRoute({
		component: () => <StorePanel items={items} counters={counters} />,
	});
	const router = createRouter({
		routeTree: root.addChildren(
			["/", "/rewards"].map((path) =>
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

const OBEDIENCE = counter("obedience", "Obedience", 40);
const SERVICE = counter("service", "Service", 2);

describe("StorePanel", () => {
	afterEach(cleanup);

	it("lists what the currency covers and leaves out what it doesn't", async () => {
		// The panel is silent rather than showing a "0 within reach" row, so the
		// out-of-reach item has to be absent from a panel that is otherwise here —
		// asserting on an empty container would pass before the router had rendered.
		renderPanel(
			[
				item("bath", "A long bath", "obedience", 30),
				item("weekend", "A weekend away", "obedience", 500),
			],
			[OBEDIENCE],
		);
		expect(await screen.findByText(/A long bath/)).not.toBeNull();
		expect(screen.queryByText(/A weekend away/)).toBeNull();
	});

	it("names the currency the price is measured against", async () => {
		renderPanel([item("bath", "A long bath", "obedience", 30)], [OBEDIENCE]);
		fireEvent.click(
			await screen.findByRole("button", { name: "What is this?" }),
		);
		expect(screen.getByText(/Obedience at 40/)).not.toBeNull();
	});

	it("names both currencies when two are in play", async () => {
		// ADR 0015 makes each score its own counter, so this is the ordinary case.
		renderPanel(
			[
				item("bath", "A long bath", "obedience", 30),
				item("lie-in", "A lie-in", "service", 1),
			],
			[OBEDIENCE, SERVICE],
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "What is this?" }),
		);
		expect(screen.getByText(/Obedience at 40.*Service at 2/)).not.toBeNull();
	});
});
