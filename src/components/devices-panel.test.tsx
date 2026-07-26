// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("#/lib/api.ts", () => ({
	listDevices: vi.fn(() => Promise.resolve({ devices: DEVICES })),
	mintDevice: vi.fn(() => Promise.resolve({ token: "tok" })),
	revokeDevice: vi.fn(() => Promise.resolve({ ok: true })),
}));

vi.mock("#/lib/identity.ts", () => ({
	clearCredentials: vi.fn(),
	hasIdentity: () => true,
}));

vi.mock("#/lib/pin.ts", () => ({ clearPin: vi.fn() }));

import { listDevices, revokeDevice } from "#/lib/api.ts";
import { clearCredentials } from "#/lib/identity.ts";
import { clearPin } from "#/lib/pin.ts";
import type { Device } from "#/shared/identity.ts";
import { DevicesPanel } from "./devices-panel.tsx";

/**
 * Revoking a device can't be walked back — there is no un-revoke, and a token
 * is shown exactly once — so it takes the house two-tap inline confirm (#117,
 * the guard #93 rolled out everywhere else).
 *
 * The row flagged `current` is the sharp one: `current` is only ever true on a
 * device linked *by token*, which holds no root secret and so cannot re-mint
 * for itself. Revoking it from the same tap that revokes your other devices is
 * a one-mis-tap lockout, so it reads as signing out instead.
 */

const DEVICES: Device[] = [
	{
		device_id: "d-phone",
		label: "Phone",
		created_at: 1_700_000_000_000,
		revoked_at: null,
		current: true,
	},
	{
		device_id: "d-laptop",
		label: "Laptop",
		created_at: 1_700_000_100_000,
		revoked_at: null,
		current: false,
	},
];

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

async function renderPanel() {
	render(<DevicesPanel />);
	// The panel loads its devices in an effect; let that settle before asserting.
	await act(async () => {});
}

describe("revoking another device", () => {
	beforeEach(() => {
		vi.mocked(listDevices).mockClear();
		vi.mocked(revokeDevice).mockClear();
	});
	afterEach(cleanup);

	it("does not revoke on the first tap", async () => {
		await renderPanel();
		click("Revoke");
		expect(vi.mocked(revokeDevice)).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Yes, revoke" })).not.toBeNull();
	});

	it("names what the revoke costs before the second tap", async () => {
		await renderPanel();
		click("Revoke");
		expect(screen.getByText(/fresh token/i)).not.toBeNull();
	});

	it("revokes on the second tap", async () => {
		await renderPanel();
		click("Revoke");
		click("Yes, revoke");
		await act(async () => {});
		expect(vi.mocked(revokeDevice)).toHaveBeenCalledWith("d-laptop");
	});

	it("cancelling drops the confirm without revoking", async () => {
		await renderPanel();
		click("Revoke");
		click("Cancel");
		expect(vi.mocked(revokeDevice)).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Yes, revoke" })).toBeNull();
		expect(screen.getByRole("button", { name: "Revoke" })).not.toBeNull();
	});

	// One armed row at a time, so a stray tap can never land on a confirm the
	// user armed for a different device.
	it("arming this device's sign-out disarms the other row", async () => {
		await renderPanel();
		click("Revoke");
		click("Sign this device out");
		expect(screen.queryByRole("button", { name: "Yes, revoke" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Yes, sign out" }),
		).not.toBeNull();
	});
});

describe("the device you're holding", () => {
	beforeEach(() => {
		vi.mocked(revokeDevice).mockClear();
		vi.mocked(clearCredentials).mockClear();
		vi.mocked(clearPin).mockClear();
	});
	afterEach(cleanup);

	// A bare "Revoke" on the current row reads like revoking one of your *other*
	// devices, and there is no un-revoke to fall back on.
	it("is not offered a bare Revoke", async () => {
		await renderPanel();
		expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
		expect(
			screen.getByRole("button", { name: "Sign this device out" }),
		).not.toBeNull();
	});

	it("does not sign out on the first tap", async () => {
		await renderPanel();
		click("Sign this device out");
		expect(vi.mocked(revokeDevice)).not.toHaveBeenCalled();
		expect(vi.mocked(clearCredentials)).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Yes, sign out" }),
		).not.toBeNull();
	});

	// The token being revoked is this device's only credential: leaving it in
	// storage just 401s on the next load, and the PIN gates the whole app for
	// whoever picks the phone up next.
	it("revokes and clears this device's credential on the second tap", async () => {
		await renderPanel();
		click("Sign this device out");
		click("Yes, sign out");
		await act(async () => {});
		expect(vi.mocked(revokeDevice)).toHaveBeenCalledWith("d-phone");
		expect(vi.mocked(clearCredentials)).toHaveBeenCalled();
		expect(vi.mocked(clearPin)).toHaveBeenCalled();
	});

	it("says where the way back is once signed out", async () => {
		await renderPanel();
		click("Sign this device out");
		click("Yes, sign out");
		await act(async () => {});
		expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
		expect(screen.getByText(/signed out/i)).not.toBeNull();
		expect(screen.getByText(/device that still works/i)).not.toBeNull();
	});

	// The credential is gone, so re-listing would only 401 and paint an error
	// over the explanation of what just happened.
	it("does not re-list devices after signing out", async () => {
		await renderPanel();
		vi.mocked(listDevices).mockClear();
		click("Sign this device out");
		click("Yes, sign out");
		await act(async () => {});
		expect(vi.mocked(listDevices)).not.toHaveBeenCalled();
	});

	it("a failed sign-out keeps the credential", async () => {
		vi.mocked(revokeDevice).mockRejectedValueOnce(new Error("offline"));
		await renderPanel();
		click("Sign this device out");
		click("Yes, sign out");
		await act(async () => {});
		expect(vi.mocked(clearCredentials)).not.toHaveBeenCalled();
		expect(screen.getByText("offline")).not.toBeNull();
	});
});
