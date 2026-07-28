import { sha256Base64url } from "./crypto.ts";

/**
 * Client-side PIN lock (handoff §3.5, #42) — a discretion feature. It keeps a
 * casual glance out of the app on an unlocked, shared, or borrowed device; it is
 * deliberately *not* a cryptographic boundary against someone who fully controls
 * the device (the relationship data is protected by the bearer credential, not
 * this PIN). Only a hash of the PIN is stored locally; the plaintext never is.
 *
 * "Locked" is per browser session: setting/verifying a PIN unlocks the current
 * session, and the lock re-engages on the next fresh load while a PIN is set —
 * or sooner, when someone locks deliberately or the app was away past the
 * auto-lock delay (#97). Waiting on a fresh load was the whole gap: the moment
 * you actually want the cover is the moment you hand the phone over, and that
 * moment never reloads anything.
 */

// Neutral, cover-name storage keys (#42): a casual glance at this device's
// localStorage must not surface the "strawberry" codename the discretion feature
// exists to hide. They sit under the same bland "habits" label as APP_NAME. (The
// PIN hash's salt is never persisted, so it isn't a storage-inspection leak.)
const PIN_HASH_KEY = "habits.pin_hash";
const UNLOCKED_KEY = "habits.pin_unlocked";
const AUTO_LOCK_KEY = "habits.pin_auto_lock_min";
const AWAY_AT_KEY = "habits.pin_away_at";
/**
 * A counter every deliberate lock bumps, purely so the other tabs on this device
 * hear about it — "unlocked" is per tab (sessionStorage), so without a shared
 * key a lock would cover the tab you tapped it in and leave the one behind it
 * readable. The value says nothing; only that it changed.
 */
const LOCK_SEQ_KEY = "habits.pin_lock_seq";

/** The auto-lock delay meaning "don't" — the default while nobody chooses one. */
export const AUTO_LOCK_OFF = 0;

/** Hashes a PIN for storage. Salted by a fixed app label (see the caveat above). */
export function hashPin(pin: string): Promise<string> {
	return sha256Base64url(`strawberry:pin:${pin}`);
}

/** Whether `pin` hashes to `storedHash`. Pure; false when no PIN is set. */
export async function pinMatches(
	storedHash: string | null,
	pin: string,
): Promise<boolean> {
	if (storedHash === null) return false;
	return storedHash === (await hashPin(pin));
}

/** Whether a PIN lock is configured on this device. */
export function isPinSet(): boolean {
	return localStorage.getItem(PIN_HASH_KEY) !== null;
}

/** Sets (or replaces) the PIN and unlocks the current session. */
export async function setPin(pin: string): Promise<void> {
	localStorage.setItem(PIN_HASH_KEY, await hashPin(pin));
	unlock();
}

/** Removes the PIN lock entirely, auto-lock delay and all. */
export function clearPin(): void {
	localStorage.removeItem(PIN_HASH_KEY);
	localStorage.removeItem(AUTO_LOCK_KEY);
	localStorage.removeItem(LOCK_SEQ_KEY);
	sessionStorage.removeItem(UNLOCKED_KEY);
	sessionStorage.removeItem(AWAY_AT_KEY);
	notify();
}

/** Verifies a PIN against the stored hash, unlocking the session on success. */
export async function verifyPin(pin: string): Promise<boolean> {
	const ok = await pinMatches(localStorage.getItem(PIN_HASH_KEY), pin);
	if (ok) unlock();
	return ok;
}

/** Marks the current browser session as unlocked. */
export function unlock(): void {
	sessionStorage.setItem(UNLOCKED_KEY, "1");
	sessionStorage.removeItem(AWAY_AT_KEY);
	notify();
}

/**
 * Locks the app now — the "hand the phone over" control (#97). Re-engaging the
 * cover is all it does: the PIN itself stays set, so unlocking is the same
 * entry as any other. Every tab on the device goes with it, since the person you
 * handed the phone to is holding all of them.
 */
export function lock(): void {
	lockThisTab();
	const seq = Number(localStorage.getItem(LOCK_SEQ_KEY) ?? 0);
	localStorage.setItem(LOCK_SEQ_KEY, String(seq + 1));
}

/** Covers this tab without announcing it — the half a received lock reuses. */
function lockThisTab(): void {
	sessionStorage.removeItem(UNLOCKED_KEY);
	sessionStorage.removeItem(AWAY_AT_KEY);
	notify();
}

/**
 * Applies a lock another tab performed, given the `storage` event that carried
 * it. Ignores every other key, and never re-announces — a received lock that
 * echoed would bounce between tabs forever.
 */
export function applyLockBroadcast(event: StorageEvent): void {
	if (event.key !== LOCK_SEQ_KEY || event.newValue === null) return;
	lockThisTab();
}

/** True when a PIN is set and this session has not been unlocked yet. */
export function isLocked(): boolean {
	return isPinSet() && sessionStorage.getItem(UNLOCKED_KEY) !== "1";
}

const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

/**
 * Subscribes to every change in this device's lock state — locked, unlocked, and
 * the PIN itself being set or removed. The gate and the "Lock now" control are
 * mounted for the life of the app, so without this a deliberate lock would only
 * show up on the next fresh load, which is exactly the wait #97 is about.
 * Returns the unsubscribe.
 */
export function subscribeLock(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * The auto-lock delay in minutes, or {@link AUTO_LOCK_OFF} when the app should
 * stay unlocked however long it sits in the background. Off unless chosen.
 */
export function getAutoLockMinutes(): number {
	const stored = Number(localStorage.getItem(AUTO_LOCK_KEY));
	return Number.isFinite(stored) && stored > 0 ? stored : AUTO_LOCK_OFF;
}

/** Sets the auto-lock delay; {@link AUTO_LOCK_OFF} turns it off. */
export function setAutoLockMinutes(minutes: number): void {
	if (minutes > 0) localStorage.setItem(AUTO_LOCK_KEY, String(minutes));
	else localStorage.removeItem(AUTO_LOCK_KEY);
	notify();
}

/**
 * Records that the app went out of sight, for {@link lockIfAwayTooLong} to read
 * when it comes back. Deliberately a timestamp rather than a timer: a hidden tab
 * gets its timers throttled or frozen outright, so the only reading anyone can
 * trust is taken on return.
 */
export function markAway(at: number = Date.now()): void {
	if (!isPinSet() || getAutoLockMinutes() === AUTO_LOCK_OFF) return;
	sessionStorage.setItem(AWAY_AT_KEY, String(at));
}

/**
 * Locks if the app was out of sight for longer than the auto-lock delay; call it
 * when the app comes back into view. Returns whether it locked. The away mark is
 * consumed either way, so one trip away can only lock once.
 *
 * A phone that sleeps or an app that gets switched away is what this covers — a
 * window left open in front of you stays unlocked, since a tab you are looking
 * at was never the exposure.
 */
export function lockIfAwayTooLong(at: number = Date.now()): boolean {
	const away = sessionStorage.getItem(AWAY_AT_KEY);
	sessionStorage.removeItem(AWAY_AT_KEY);

	const minutes = getAutoLockMinutes();
	if (away === null || minutes === AUTO_LOCK_OFF || isLocked()) return false;
	// A clock that jumped backwards reads as a negative gap; leave it alone
	// rather than lock on a number that means nothing.
	if (at - Number(away) < minutes * 60_000) return false;

	lock();
	return true;
}
