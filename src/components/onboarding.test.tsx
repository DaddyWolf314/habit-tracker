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
	ApiError: class ApiError extends Error {},
	confirmRoles: vi.fn(() => Promise.resolve(roles())),
	createIdentity: vi.fn(() => Promise.resolve({})),
	createInvite: vi.fn(() =>
		Promise.resolve({ code: "abc-123", expires_at: 1_700_000_900_000 }),
	),
	getRoles: vi.fn(() => Promise.resolve(roles())),
	getSession: vi.fn(() => Promise.resolve({})),
	linkDevice: vi.fn(() => Promise.resolve({})),
	proposeRoles: vi.fn(() => Promise.resolve(roles())),
	redeemInvite: vi.fn(() => Promise.resolve({})),
}));

vi.mock("#/lib/identity.ts", () => ({
	clearCredentials: vi.fn(),
	generateSecret: vi.fn(),
	hasIdentity: () => true,
	secretFromMnemonic: vi.fn(),
	storeDeviceToken: vi.fn(),
	storeSecret: vi.fn(),
}));

import { confirmRoles, createInvite } from "#/lib/api.ts";
import type { RoleConfirmationState } from "#/shared/identity.ts";
import { InvitePanel, RolesPanel } from "./onboarding.tsx";

/**
 * Two taps on the pre-dynamic home that can't be walked back (#93).
 *
 * Confirming roles is the heavier one: the second partner's confirmation
 * activates the couple, after which `proposeRoles` refuses forever ("roles are
 * already confirmed") and there is no reassignment endpoint — the only way out
 * of a wrong assignment is dissolving the space and losing all of its history.
 * Regenerating an invite silently kills the code already sent to the partner.
 */

/** A partner's proposal waiting on this member — the state the Confirm tap lives in. */
function roles(
	over: Partial<RoleConfirmationState> = {},
): RoleConfirmationState {
	return {
		members: [
			{ member_id: "m1", role: null, is_self: true },
			{ member_id: "m2", role: null, is_self: false },
		],
		assignment: { m1: "sub", m2: "dom" },
		proposed_by: "m2",
		confirmed_by: [],
		active: false,
		...over,
	};
}

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

async function renderRoles() {
	render(<RolesPanel onActivated={() => {}} />);
	// The panel reads the proposal in an effect; let it settle before asserting.
	await act(async () => {});
}

describe("confirming roles", () => {
	beforeEach(() => {
		vi.mocked(confirmRoles).mockClear();
	});
	afterEach(cleanup);

	it("does not confirm on the first tap", async () => {
		await renderRoles();
		click("Confirm these roles");
		expect(vi.mocked(confirmRoles)).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Yes, these are our roles" }),
		).not.toBeNull();
	});

	it("says the choice is permanent before taking it", async () => {
		await renderRoles();
		click("Confirm these roles");
		expect(screen.getByText(/can't be reassigned/i)).not.toBeNull();
	});

	it("confirms on the second tap", async () => {
		await renderRoles();
		click("Confirm these roles");
		click("Yes, these are our roles");
		await act(async () => {});
		expect(vi.mocked(confirmRoles)).toHaveBeenCalled();
	});

	it("backing out drops the confirm without activating", async () => {
		await renderRoles();
		click("Confirm these roles");
		click("Not yet");
		expect(vi.mocked(confirmRoles)).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Yes, these are our roles" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Confirm these roles" }),
		).not.toBeNull();
	});
});

describe("regenerating an invite code", () => {
	beforeEach(() => {
		vi.mocked(createInvite).mockClear();
	});
	afterEach(cleanup);

	/** Gets the panel past the first, additive "Create invite" tap. */
	async function renderWithLiveInvite() {
		render(<InvitePanel onRefresh={() => {}} />);
		click("Create invite");
		await act(async () => {});
		vi.mocked(createInvite).mockClear();
	}

	it("creates the first code on a single tap — nothing exists to lose yet", async () => {
		render(<InvitePanel onRefresh={() => {}} />);
		click("Create invite");
		await act(async () => {});
		expect(vi.mocked(createInvite)).toHaveBeenCalled();
	});

	it("does not replace a live code on the first tap", async () => {
		await renderWithLiveInvite();
		click("New code");
		expect(vi.mocked(createInvite)).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Yes, replace it" }),
		).not.toBeNull();
	});

	it("replaces on the second tap", async () => {
		await renderWithLiveInvite();
		click("New code");
		click("Yes, replace it");
		await act(async () => {});
		expect(vi.mocked(createInvite)).toHaveBeenCalled();
	});

	it("backing out keeps the code already sent", async () => {
		await renderWithLiveInvite();
		click("New code");
		click("Keep the old code");
		expect(vi.mocked(createInvite)).not.toHaveBeenCalled();
		expect(screen.getByText("abc-123")).not.toBeNull();
	});
});
