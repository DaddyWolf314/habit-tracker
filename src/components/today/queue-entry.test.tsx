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
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { Role } from "#/shared/roles.ts";
import { QueueEntry } from "./queue-entry.tsx";

/**
 * §8.1's entry to the queue, and §8.3's refusal of one (#136). What this pins is
 * mostly *absence*: a sub gets no row, because a home-screen count of how many
 * of their confessions are still being judged is the "anxiety mechanic" §8.3
 * declines. Their pending state is the quiet chip in the log, which already
 * exists.
 */

const INFRACTION: EventType = {
	id: "infraction",
	label: "Infraction",
	valence: "negative",
	log_permission: ["dom", "sub", "switch"],
	subject_required: false,
	metadata: {
		severity: {
			kind: "enum",
			options: ["minor", "major"],
			label: "Severity",
			required: false,
			set_permission: ["dom", "sub", "switch"],
			adjudicated_by: ["dom"],
		},
	},
	awaiting: ["severity"],
	journaling: false,
};

const MEMBERS: RoleMember[] = [
	{ member_id: "dom1", role: "dom", is_self: false },
	{ member_id: "sub1", role: "sub", is_self: true },
];

function pending(id: string): EventView {
	return {
		id,
		type: "infraction",
		actor: "sub1",
		occurred_at: 1_000,
		logged_at: 1_000,
		metadata: {},
		visibility: "shared",
		amendments: [],
		composite_metadata: {},
		pending: true,
		retracted: false,
	} as EventView;
}

/** Renders inside a router, since the entry is a link to the queue. */
function renderEntry(events: EventView[], selfRole: Role | null) {
	const root = createRootRoute({
		component: () => (
			<QueueEntry
				events={events}
				types={[INFRACTION]}
				members={MEMBERS}
				selfRole={selfRole}
			/>
		),
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
	// biome-ignore lint/suspicious/noExplicitAny: the test router isn't the app's
	return render(<RouterProvider router={router as any} />);
}

describe("QueueEntry", () => {
	afterEach(cleanup);

	it("tells a member who rules how much awaits them", async () => {
		renderEntry([pending("e1"), pending("e2")], "dom");
		expect(
			await screen.findByText(/2 things await your ruling/i),
		).not.toBeNull();
	});

	it("counts one thing without pluralising it", async () => {
		renderEntry([pending("e1")], "dom");
		expect(
			await screen.findByText(/1 thing awaits your ruling/i),
		).not.toBeNull();
	});

	it("shows the sub nothing at all", async () => {
		// The defect this issue exists for, seen from the screen: their own
		// confessions are not a number on their home page.
		const { container } = renderEntry([pending("e1")], "sub");
		await Promise.resolve();
		expect(container.textContent).toBe("");
	});

	it("shows nothing when nothing awaits a ruling", async () => {
		const { container } = renderEntry([], "dom");
		await Promise.resolve();
		expect(container.textContent).toBe("");
	});

	it("shows nothing before roles are confirmed", async () => {
		const { container } = renderEntry([pending("e1")], null);
		await Promise.resolve();
		expect(container.textContent).toBe("");
	});
});
