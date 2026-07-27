// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	getSession: vi.fn(),
	getNotifications: vi.fn(),
}));
vi.mock("#/lib/identity.ts", () => ({ hasIdentity: vi.fn(() => true) }));

import { getNotifications, getSession } from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import type { Session } from "#/shared/identity.ts";
import { TabBar, TabBarNav } from "./tab-bar.tsx";

/**
 * The tab bar is the app's navigation (#85): before it, every surface was a
 * spoke off `/` with a text "Back" link, so the dom's daily loop crossed the hub
 * on every hop. Three things are load-bearing and covered here — it only appears
 * once the dynamic is active (a half-paired couple has nowhere to go yet), it
 * marks where you are, and it carries the content-free unread count so the badge
 * survived moving off the old home page.
 */

const PATHS = ["/", "/today", "/log", "/rules", "/settings", "/devices"];

function renderAt(path: string, ui: React.ReactNode) {
	const rootRoute = createRootRoute({ component: () => <>{ui}</> });
	const routeTree = rootRoute.addChildren(
		PATHS.map((p) =>
			createRoute({
				getParentRoute: () => rootRoute,
				path: p,
				component: () => null,
			}),
		),
	);
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	// The app registers its own router type globally; this memory router stands
	// in for it so the test can drive Link state without the real surfaces.
	render(<RouterProvider router={router as never} />);
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		couple_do_id: "do",
		member_id: "m1",
		identity_hash: "h",
		role: "dom",
		status: "active",
		member_count: 2,
		invitations_closed: true,
		roles_active: true,
		paused: false,
		recovery_pending: false,
		...overrides,
	};
}

describe("TabBarNav", () => {
	afterEach(cleanup);

	it("offers the daily surfaces as one persistent nav", async () => {
		renderAt("/today", <TabBarNav />);
		const nav = await screen.findByRole("navigation", { name: "Main" });
		expect(
			[...nav.querySelectorAll("a")].map((a) => a.textContent?.trim()),
			// Rules left the bar in #123: authoring automation is a rare act, and the
			// bar's own rule is that anything rarer than daily hangs off Settings.
		).toEqual(["Today", "Log", "Settings"]);
	});

	it("marks the surface you are on", async () => {
		renderAt("/log", <TabBarNav />);
		await screen.findByRole("navigation", { name: "Main" });
		expect(
			screen.getByRole("link", { name: "Log" }).getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen.getByRole("link", { name: "Today" }).getAttribute("aria-current"),
		).toBeNull();
	});

	it("shows the unread count on Log, and nothing at zero", async () => {
		renderAt("/today", <TabBarNav unread={3} />);
		await screen.findByRole("navigation", { name: "Main" });
		// Content-free (#42): a bare count, never what the items are.
		expect(
			screen.getByRole("link", { name: "Log, 3 new items" }),
		).not.toBeNull();

		cleanup();
		renderAt("/today", <TabBarNav unread={0} />);
		await screen.findByRole("navigation", { name: "Main" });
		expect(screen.getByRole("link", { name: "Log" })).not.toBeNull();
	});

	it("says 'item' when there is only one", async () => {
		renderAt("/today", <TabBarNav unread={1} />);
		await screen.findByRole("navigation", { name: "Main" });
		expect(
			screen.getByRole("link", { name: "Log, 1 new item" }),
		).not.toBeNull();
	});
});

describe("TabBar", () => {
	beforeEach(() => {
		vi.mocked(hasIdentity).mockReturnValue(true);
		vi.mocked(getNotifications).mockResolvedValue({ unread: 0 });
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("stays hidden until the dynamic is active", async () => {
		vi.mocked(getSession).mockResolvedValue(
			session({ status: "pairing", member_count: 1, roles_active: false }),
		);
		renderAt("/", <TabBar />);
		await waitFor(() => expect(getSession).toHaveBeenCalled());
		expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
	});

	it("appears once roles are confirmed", async () => {
		vi.mocked(getSession).mockResolvedValue(session());
		renderAt("/today", <TabBar />);
		expect(
			await screen.findByRole("navigation", { name: "Main" }),
		).not.toBeNull();
	});

	it("does not poll a space this device can't read", async () => {
		vi.mocked(hasIdentity).mockReturnValue(false);
		renderAt("/", <TabBar />);
		await waitFor(() =>
			expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull(),
		);
		expect(getSession).not.toHaveBeenCalled();
		expect(getNotifications).not.toHaveBeenCalled();
	});
});
