// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAutoLockMinutes,
	lock,
	markAway,
	setAutoLockMinutes,
	setPin,
} from "#/lib/pin.ts";
import { PinGate, PinSettings } from "./pin-gate.tsx";

/**
 * The PIN lock is a discretion feature (handoff §3.5, #42) and these are the
 * moments it has to work in: someone hands the phone over, or puts it down and
 * comes back to it (#97). Both used to need a fresh load — the gate only checked
 * on mount — which is to say the cover arrived long after the glance did.
 */

const MINUTE = 60_000;

/**
 * The cover-named key (#42) a lock in one tab announces itself through. Spelled
 * out here because a `storage` event is the only way to play the second tab, and
 * pinning the literal keeps the neutral name honest.
 */
const LOCK_SEQ_KEY = "habits.pin_lock_seq";

afterEach(() => {
	cleanup();
	localStorage.clear();
	sessionStorage.clear();
	vi.restoreAllMocks();
	setVisibility("visible");
});

/** jsdom reports a page nobody can hide; drive it directly. */
function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		value: state,
		configurable: true,
	});
}

function goAway() {
	act(() => {
		setVisibility("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

function comeBack() {
	act(() => {
		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

function locked() {
	return screen.queryByLabelText("PIN") !== null;
}

describe("PinGate", () => {
	it("shows the app when no PIN is set", async () => {
		render(<PinGate>secret content</PinGate>);
		expect(await screen.findByText("secret content")).not.toBeNull();
	});

	it("covers the app the moment someone locks it, with no reload", async () => {
		await setPin("1234");
		render(<PinGate>secret content</PinGate>);
		expect(await screen.findByText("secret content")).not.toBeNull();

		act(() => lock());

		expect(locked()).toBe(true);
		expect(screen.queryByText("secret content")).toBeNull();
	});

	it("locks on return when the app sat away past the delay", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		render(<PinGate>secret content</PinGate>);
		await screen.findByText("secret content");

		vi.spyOn(Date, "now").mockReturnValue(0);
		goAway();
		vi.spyOn(Date, "now").mockReturnValue(6 * MINUTE);
		comeBack();

		expect(locked()).toBe(true);
	});

	it("leaves a quick glance away alone", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		render(<PinGate>secret content</PinGate>);
		await screen.findByText("secret content");

		vi.spyOn(Date, "now").mockReturnValue(0);
		goAway();
		vi.spyOn(Date, "now").mockReturnValue(1 * MINUTE);
		comeBack();

		expect(locked()).toBe(false);
	});

	it("never auto-locks while the delay is off", async () => {
		await setPin("1234");
		render(<PinGate>secret content</PinGate>);
		await screen.findByText("secret content");

		vi.spyOn(Date, "now").mockReturnValue(0);
		goAway();
		vi.spyOn(Date, "now").mockReturnValue(600 * MINUTE);
		comeBack();

		expect(locked()).toBe(false);
	});

	it("locks on a load that lands after too long away", async () => {
		// A backgrounded tab the OS discarded comes back through a fresh load, and
		// the unlocked mark survives it — so the check has to run on mount too, not
		// only when a visibility change announces the return.
		await setPin("1234");
		setAutoLockMinutes(5);
		vi.spyOn(Date, "now").mockReturnValue(0);
		markAway();

		vi.spyOn(Date, "now").mockReturnValue(30 * MINUTE);
		render(<PinGate>secret content</PinGate>);

		expect(await screen.findByLabelText("PIN")).not.toBeNull();
		expect(screen.queryByText("secret content")).toBeNull();
	});

	it("covers this tab when another tab locks the device", async () => {
		await setPin("1234");
		render(<PinGate>secret content</PinGate>);
		await screen.findByText("secret content");

		act(() => {
			window.dispatchEvent(
				new StorageEvent("storage", {
					key: LOCK_SEQ_KEY,
					newValue: "1",
				}),
			);
		});

		expect(locked()).toBe(true);
	});
});

describe("PinSettings", () => {
	it("offers a delay only once there is a PIN to delay", async () => {
		render(<PinSettings />);
		await screen.findByRole("button", { name: /^Set$/ });
		expect(screen.queryByLabelText(/Lock automatically/)).toBeNull();

		cleanup();
		await setPin("1234");
		render(<PinSettings />);
		expect(await screen.findByLabelText(/Lock automatically/)).not.toBeNull();
	});

	it("keeps the chosen auto-lock delay", async () => {
		await setPin("1234");
		render(<PinSettings />);

		const select = await screen.findByLabelText(/Lock automatically/);
		fireEvent.change(select, { target: { value: "15" } });

		expect(getAutoLockMinutes()).toBe(15);
	});
});
