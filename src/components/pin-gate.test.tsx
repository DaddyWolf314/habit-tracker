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
	markTouched,
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
/** Likewise the delay and the PIN, which a second tab can change under this one. */
const AUTO_LOCK_KEY = "habits.pin_auto_lock_min";
const PIN_HASH_KEY = "habits.pin_hash";

afterEach(() => {
	cleanup();
	localStorage.clear();
	sessionStorage.clear();
	vi.restoreAllMocks();
	vi.useRealTimers();
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

/** Somebody is still there: the cheapest of the events the watch listens for. */
function touch() {
	act(() => {
		window.dispatchEvent(new Event("pointerdown"));
	});
}

/** Lets `ms` pass with nobody touching anything, timers and clock together. */
function sitStill(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
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

	/**
	 * The desk case (#145). The away rule never reached it: a tab you walked away
	 * from without switching off is still the foreground tab, still in view, and
	 * so never counted as away at all.
	 */
	it("locks a tab left sitting in view untouched past the delay", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		vi.useFakeTimers();
		render(<PinGate>secret content</PinGate>);
		expect(locked()).toBe(false);

		sitStill(6 * MINUTE);

		expect(locked()).toBe(true);
		expect(screen.queryByText("secret content")).toBeNull();
	});

	it("starts the wait over every time somebody touches it", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		vi.useFakeTimers();
		render(<PinGate>secret content</PinGate>);

		sitStill(4 * MINUTE);
		touch();
		sitStill(4 * MINUTE);

		// Eight minutes in, on a five-minute delay, and still open — because the
		// delay measures the last touch, not the time the tab has been up.
		expect(locked()).toBe(false);

		sitStill(2 * MINUTE);

		expect(locked()).toBe(true);
	});

	it("never locks an untouched tab while the delay is off", async () => {
		await setPin("1234");
		vi.useFakeTimers();
		render(<PinGate>secret content</PinGate>);

		sitStill(600 * MINUTE);

		expect(locked()).toBe(false);
	});

	/**
	 * Hidden time belongs to the away rule, which reads it on return. If the
	 * untouched timer locked while hidden too, a second tab someone is actively
	 * typing in would go dark with it — the lock reaches every tab on the device.
	 */
	it("leaves hidden time to the away check rather than locking behind it", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		vi.useFakeTimers();
		render(<PinGate>secret content</PinGate>);

		goAway();
		sitStill(6 * MINUTE);
		expect(locked()).toBe(false);

		comeBack();

		expect(locked()).toBe(true);
	});

	/**
	 * A lock reaches every tab, so a tab nobody has touched must not lock on top
	 * of a window somebody is typing in — two windows side by side are both
	 * "visible", and neither hears the other's input. Having declined, though, it
	 * has to keep watching: the wait starts over rather than ending for good.
	 */
	it("waits for the window in use, then locks once that goes quiet too", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		vi.useFakeTimers();
		render(<PinGate>secret content</PinGate>);

		sitStill(4 * MINUTE);
		act(() => markTouched());
		sitStill(2 * MINUTE);

		expect(locked()).toBe(false);

		sitStill(5 * MINUTE);

		expect(locked()).toBe(true);
	});

	/**
	 * The delay lives in localStorage, so a tab that never hears it change goes on
	 * waiting the old one out. Here the change is a shortening — this tab has to
	 * pick it up rather than sit on the fifteen minutes it started with.
	 */
	it("takes up a delay shortened in another tab", async () => {
		await setPin("1234");
		setAutoLockMinutes(15);
		vi.useFakeTimers();
		render(<PinGate>secret content</PinGate>);

		act(() => {
			// Play the other tab: the raw write, then the event this one hears.
			// `setAutoLockMinutes` would notify locally and prove nothing.
			localStorage.setItem(AUTO_LOCK_KEY, "1");
			window.dispatchEvent(
				new StorageEvent("storage", {
					key: AUTO_LOCK_KEY,
					newValue: "1",
				}),
			);
		});
		sitStill(2 * MINUTE);

		expect(locked()).toBe(true);
	});

	/**
	 * The stuck case: this tab is covered, and the PIN it would take to open it
	 * was removed in another tab. Nothing entered here can match a hash that is
	 * gone, so without hearing the removal this tab sits on a lock screen with no
	 * way past it until a reload.
	 */
	it("uncovers when the PIN it wants is removed in another tab", async () => {
		await setPin("1234");
		render(<PinGate>secret content</PinGate>);
		act(() => lock());
		expect(locked()).toBe(true);

		act(() => {
			localStorage.removeItem(PIN_HASH_KEY);
			window.dispatchEvent(
				new StorageEvent("storage", { key: PIN_HASH_KEY, newValue: null }),
			);
		});

		expect(locked()).toBe(false);
		expect(screen.queryByText("secret content")).not.toBeNull();
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
