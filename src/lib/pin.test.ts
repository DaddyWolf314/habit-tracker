// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyLockBroadcast,
	clearPin,
	getAutoLockMinutes,
	hashPin,
	isLocked,
	lock,
	lockIfAwayTooLong,
	lockIfUntouchedTooLong,
	markAway,
	markTouched,
	pinMatches,
	setAutoLockMinutes,
	setPin,
	subscribeLock,
	unlock,
	verifyPin,
} from "./pin.ts";

/**
 * The PIN lock is a discretion feature (handoff §3.5, #42), not a cryptographic
 * boundary against someone who already controls the device — it keeps a casual
 * over-the-shoulder glance out. The stored value is only ever a hash of the PIN;
 * the plaintext PIN is never persisted.
 *
 * Runs under jsdom because the lock's state lives in local/session storage: what
 * is worth covering here is not the hash but *when the app is covered* — the
 * deliberate lock (#97) and the away-timeout that re-engages it — so the tests
 * drive the real storage rather than a stand-in for it.
 */

const MINUTE = 60_000;

/**
 * The cover-named key (#42) one tab's lock announces itself through. Spelled out
 * here because a `storage` event is the only way to play a second tab, and
 * pinning the literal keeps the neutral name honest.
 */
const LOCK_SEQ_KEY = "habits.pin_lock_seq";

afterEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe("hashPin", () => {
	it("is deterministic for the same PIN", async () => {
		expect(await hashPin("1234")).toBe(await hashPin("1234"));
	});

	it("differs for different PINs and never returns the plaintext", async () => {
		const h = await hashPin("1234");
		expect(h).not.toBe(await hashPin("4321"));
		expect(h).not.toContain("1234");
	});
});

describe("pinMatches", () => {
	it("accepts the PIN that produced the stored hash", async () => {
		const stored = await hashPin("2468");
		expect(await pinMatches(stored, "2468")).toBe(true);
	});

	it("rejects a wrong PIN", async () => {
		const stored = await hashPin("2468");
		expect(await pinMatches(stored, "0000")).toBe(false);
	});

	it("rejects any PIN when none is set (null store)", async () => {
		expect(await pinMatches(null, "2468")).toBe(false);
	});
});

describe("lock", () => {
	it("covers a session that had already been unlocked", async () => {
		await setPin("1234");
		expect(isLocked()).toBe(false);

		lock();

		expect(isLocked()).toBe(true);
		expect(await verifyPin("1234")).toBe(true);
		expect(isLocked()).toBe(false);
	});

	it("does nothing when no PIN is set — there is nothing to lock", () => {
		lock();
		expect(isLocked()).toBe(false);
	});

	it("reaches this device's other tabs", async () => {
		await setPin("1234");

		lock();

		// "Unlocked" is per tab, so the only thing a second tab can hear is the
		// shared key changing — a lock that didn't bump it would leave that tab
		// sitting there readable.
		expect(localStorage.getItem(LOCK_SEQ_KEY)).not.toBeNull();
	});
});

describe("applyLockBroadcast", () => {
	it("covers this tab when another one announces a lock", async () => {
		await setPin("1234");

		applyLockBroadcast(
			new StorageEvent("storage", { key: LOCK_SEQ_KEY, newValue: "1" }),
		);

		expect(isLocked()).toBe(true);
	});

	it("never echoes the lock it received", async () => {
		await setPin("1234");
		const before = localStorage.getItem(LOCK_SEQ_KEY);

		applyLockBroadcast(
			new StorageEvent("storage", { key: LOCK_SEQ_KEY, newValue: "1" }),
		);

		expect(localStorage.getItem(LOCK_SEQ_KEY)).toBe(before);
	});

	it("ignores every other key on the device", async () => {
		await setPin("1234");

		applyLockBroadcast(
			new StorageEvent("storage", {
				key: "habits.something_else",
				newValue: "1",
			}),
		);

		expect(isLocked()).toBe(false);
	});
});

describe("subscribeLock", () => {
	it("tells subscribers on lock and unlock, so the gate re-covers without a reload", async () => {
		await setPin("1234");
		const listener = vi.fn();
		const unsubscribe = subscribeLock(listener);

		lock();
		expect(listener).toHaveBeenCalledTimes(1);
		unlock();
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
		lock();
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("tells subscribers when the PIN itself comes or goes", async () => {
		const listener = vi.fn();
		const unsubscribe = subscribeLock(listener);

		await setPin("1234");
		expect(listener).toHaveBeenCalled();
		listener.mockClear();

		clearPin();
		expect(listener).toHaveBeenCalled();
		unsubscribe();
	});
});

describe("auto-lock", () => {
	it("is off until it is chosen", () => {
		expect(getAutoLockMinutes()).toBe(0);
	});

	it("remembers the chosen delay on this device", () => {
		setAutoLockMinutes(15);
		expect(getAutoLockMinutes()).toBe(15);
		setAutoLockMinutes(0);
		expect(getAutoLockMinutes()).toBe(0);
	});

	it("goes away with the PIN it belongs to", async () => {
		await setPin("1234");
		setAutoLockMinutes(15);

		clearPin();

		expect(getAutoLockMinutes()).toBe(0);
	});

	it("locks on return when the app was away longer than the delay", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);

		markAway(0);
		expect(lockIfAwayTooLong(6 * MINUTE)).toBe(true);
		expect(isLocked()).toBe(true);
	});

	it("leaves a short glance away alone", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);

		markAway(0);
		expect(lockIfAwayTooLong(4 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("never locks while the delay is off, however long the app was away", async () => {
		await setPin("1234");

		markAway(0);
		expect(lockIfAwayTooLong(600 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("consumes the away mark, so a later return doesn't re-lock on it", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);

		markAway(0);
		expect(lockIfAwayTooLong(6 * MINUTE)).toBe(true);
		await verifyPin("1234");

		expect(lockIfAwayTooLong(600 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("does not mark a device with no PIN as away", () => {
		setAutoLockMinutes(5);
		markAway(0);
		expect(lockIfAwayTooLong(600 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("survives a clock that jumped backwards", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);

		markAway(10 * MINUTE);
		expect(lockIfAwayTooLong(1 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});
});

/**
 * The desk case (#145): the app in front of you, nobody touching it. The away
 * rule never covered this one — a foreground tab is never out of view — so the
 * same delay is read against the last touch instead of against a departure.
 */
describe("untouched", () => {
	it("locks a tab nobody has touched for longer than the delay", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);

		expect(lockIfUntouchedTooLong(0, 6 * MINUTE)).toBe(true);
		expect(isLocked()).toBe(true);
	});

	it("leaves a tab alone while someone is still using it", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);

		expect(lockIfUntouchedTooLong(0, 4 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("never locks while the delay is off, however long nobody touches it", async () => {
		await setPin("1234");

		expect(lockIfUntouchedTooLong(0, 600 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("does nothing on a device with no PIN — there is nothing to cover", () => {
		setAutoLockMinutes(5);

		expect(lockIfUntouchedTooLong(0, 600 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("does not re-announce a lock that already happened", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		lock();
		const announced = localStorage.getItem(LOCK_SEQ_KEY);

		expect(lockIfUntouchedTooLong(0, 600 * MINUTE)).toBe(false);
		// A second bump would cover every other tab a second time, for a lock they
		// have already been told about.
		expect(localStorage.getItem(LOCK_SEQ_KEY)).toBe(announced);
	});

	it("survives a clock that jumped backwards", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);

		expect(lockIfUntouchedTooLong(10 * MINUTE, 1 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("waits on the tab somebody is using, not just on its own reading", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);

		// This tab has sat quiet for six minutes, but the input went to another
		// window on the same device a minute ago — and a lock covers that one too.
		markTouched(5 * MINUTE);

		expect(lockIfUntouchedTooLong(0, 6 * MINUTE)).toBe(false);
		expect(isLocked()).toBe(false);
	});

	it("locks once every tab on the device has gone quiet", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		markTouched(0);

		expect(lockIfUntouchedTooLong(0, 6 * MINUTE)).toBe(true);
		expect(isLocked()).toBe(true);
	});

	it("does not record a touch on a device with no PIN", () => {
		setAutoLockMinutes(5);
		markTouched(5 * MINUTE);

		// Nothing to hold open a lock that isn't configured — and no stray mark
		// left behind for whoever sets a PIN later.
		expect(lockIfUntouchedTooLong(0, 6 * MINUTE)).toBe(false);
	});

	it("drops the device's touch mark along with the PIN", async () => {
		await setPin("1234");
		setAutoLockMinutes(5);
		markTouched(10 * MINUTE);

		clearPin();
		await setPin("1234");
		setAutoLockMinutes(5);

		// A touch from the PIN that was removed must not hold the new one open.
		expect(lockIfUntouchedTooLong(0, 11 * MINUTE)).toBe(true);
	});
});
