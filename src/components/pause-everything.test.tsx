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
	getSession: vi.fn(() => Promise.resolve(session())),
	pause: vi.fn(() => Promise.resolve({})),
	resume: vi.fn(() => Promise.resolve({})),
}));

vi.mock("#/lib/identity.ts", () => ({ hasIdentity: () => true }));

import { getSession, pause, resume } from "#/lib/api.ts";
import type { Session } from "#/shared/identity.ts";
import { PauseEverythingBar } from "./pause-everything.tsx";

/**
 * Resuming restarts every clock at once, so it takes the house two-tap inline
 * confirm (#93) — while pausing deliberately does not, since its whole point is
 * availability in a charged moment. These pin both halves of that asymmetry.
 */

/** A paused, active couple — the state the resume control lives in. */
function session(over: Partial<Session> = {}): Session {
	return {
		couple_do_id: "couple-1",
		member_id: "m1",
		identity_hash: "hash",
		role: "dom",
		status: "active",
		member_count: 2,
		invitations_closed: true,
		roles_active: true,
		paused: true,
		recovery_pending: false,
		...over,
	};
}

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

async function renderBar() {
	render(<PauseEverythingBar />);
	// The bar reads the session in an effect; let that settle before asserting.
	await act(async () => {});
}

describe("resuming from pause", () => {
	beforeEach(() => {
		vi.mocked(resume).mockClear();
		vi.mocked(pause).mockClear();
	});
	afterEach(cleanup);

	it("does not resume on the first tap", async () => {
		await renderBar();
		click("Resume");
		expect(vi.mocked(resume)).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Yes, resume everything" }),
		).not.toBeNull();
	});

	it("resumes on the second tap", async () => {
		await renderBar();
		click("Resume");
		click("Yes, resume everything");
		await act(async () => {});
		expect(vi.mocked(resume)).toHaveBeenCalled();
	});

	it("staying paused drops the confirm without resuming", async () => {
		await renderBar();
		click("Resume");
		// The negative says what taking it costs, rather than a bare "Cancel".
		click("Stay paused");
		expect(vi.mocked(resume)).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Yes, resume everything" }),
		).toBeNull();
		expect(screen.getByRole("button", { name: "Resume" })).not.toBeNull();
	});

	it("pauses on a single tap — reaching the safeword beats confirming it", async () => {
		vi.mocked(getSession).mockResolvedValueOnce(session({ paused: false }));
		await renderBar();
		click("Pause everything");
		await act(async () => {});
		expect(vi.mocked(pause)).toHaveBeenCalled();
	});
});
