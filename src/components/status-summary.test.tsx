// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Session } from "#/shared/identity.ts";
import { StatusSummary } from "./status-summary.tsx";

/**
 * The readout renders on the pre-dynamic home *and* in Settings (#85), so its
 * copy has to survive both. #149: neither the couple status nor the role may
 * reach the page as its stored value — those are database words, not something
 * you say to a person.
 */

function session(over: Partial<Session> = {}): Session {
	return {
		couple_do_id: "c1",
		member_id: "m1",
		identity_hash: "h1",
		role: "dom",
		status: "pairing",
		member_count: 1,
		invitations_closed: false,
		roles_active: false,
		paused: false,
		recovery_pending: false,
		...over,
	};
}

afterEach(cleanup);

describe("StatusSummary", () => {
	it("humanizes each couple status", () => {
		render(<StatusSummary session={session({ status: "pairing" })} />);
		expect(screen.getByText("Pairing in progress")).toBeDefined();
		expect(screen.queryByText("pairing")).toBeNull();

		cleanup();
		render(<StatusSummary session={session({ status: "active" })} />);
		expect(screen.getByText("Dynamic active")).toBeDefined();
		expect(screen.queryByText("active")).toBeNull();

		cleanup();
		render(<StatusSummary session={session({ status: "dissolved" })} />);
		expect(screen.getByText("Dissolved")).toBeDefined();
		expect(screen.queryByText("dissolved")).toBeNull();
	});

	it("labels each role without expanding the permission bucket", () => {
		for (const [role, label] of [
			["dom", "Dom"],
			["sub", "Sub"],
			["switch", "Switch"],
		] as const) {
			cleanup();
			render(<StatusSummary session={session({ role })} />);
			expect(screen.getByText(label)).toBeDefined();
			expect(screen.queryByText(role)).toBeNull();
		}
	});

	it("says so when no role is confirmed yet", () => {
		render(<StatusSummary session={session({ role: null })} />);
		expect(screen.getByText("Not set")).toBeDefined();
	});

	// The component docstring calls "1 of 2" the whole story on the pre-dynamic
	// home; #149 scoped the member count out deliberately.
	it("leaves the member count phrasing alone", () => {
		render(<StatusSummary session={session({ member_count: 1 })} />);
		expect(screen.getByText("1 of 2")).toBeDefined();
	});
});
