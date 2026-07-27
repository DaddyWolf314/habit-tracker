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
import { QueueEntry } from "./queue-entry.tsx";

/**
 * §8.1's entry to the queue, and §8.3's refusal of one (#136). The count is
 * folded server-side (`queueCount`), so what is left to pin here is how it reads
 * — and, mostly, when it renders nothing at all. A sub's count is zero because
 * nothing awaits *their* ruling, which is the whole point: their own confessions
 * are not a number on their home screen.
 */

/** Renders inside a router, since the entry is a link to the queue. */
function renderEntry(count: number) {
	const root = createRootRoute({
		component: () => <QueueEntry count={count} />,
	});
	const router = createRouter({
		routeTree: root.addChildren([
			createRoute({
				getParentRoute: () => root,
				path: "/",
				component: () => null,
			}),
			createRoute({
				getParentRoute: () => root,
				path: "/log",
				component: () => null,
			}),
		]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return render(<RouterProvider router={router as never} />);
}

describe("QueueEntry", () => {
	afterEach(cleanup);

	it("tells a member who rules how much awaits them", async () => {
		renderEntry(2);
		expect(
			await screen.findByText(/2 things await your ruling/i),
		).not.toBeNull();
	});

	it("counts one thing without pluralising it", async () => {
		renderEntry(1);
		expect(
			await screen.findByText(/1 thing awaits your ruling/i),
		).not.toBeNull();
	});

	it("renders nothing when nothing awaits a ruling", async () => {
		// Which is every sub, always: no key names them in `adjudicated_by`.
		const { container } = renderEntry(0);
		await Promise.resolve();
		expect(container.textContent).toBe("");
	});
});
