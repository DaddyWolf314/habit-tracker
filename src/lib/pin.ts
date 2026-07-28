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
 * or sooner, when someone locks deliberately (#97) or the auto-lock delay passes
 * with the app either away or untouched (#97, #145). Waiting on a fresh load was
 * the whole gap: the moment you actually want the cover is the moment you hand
 * the phone over, and that moment never reloads anything.
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
 * The last moment any tab on this device was touched (#145). Device-wide, unlike
 * the away mark, because two windows side by side are both "visible" and neither
 * hears the other's input — without this the one you are not typing in would
 * reach its deadline and lock the one you are.
 */
const TOUCHED_AT_KEY = "habits.pin_touched_at";
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
	localStorage.removeItem(TOUCHED_AT_KEY);
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
 * Applies what another tab on this device changed, given the `storage` event
 * that carried it. Ignores every other key, and never writes anything back — a
 * received change that echoed would bounce between tabs forever.
 *
 * A lock is the one that needs doing rather than re-reading, since "unlocked" is
 * per tab and no shared value describes it. The PIN and the delay are the
 * opposite: both already live in `localStorage`, so every tab can simply look
 * again. Without that look they never do, and a tab keeps acting on a PIN that
 * was removed or a delay that was changed somewhere else — including sitting on
 * a lock screen for a PIN that no longer exists to open it.
 */
export function applyDeviceChange(event: StorageEvent): void {
	if (event.key === LOCK_SEQ_KEY) {
		// Removing the key is `clearPin` tidying up, not a lock being announced.
		if (event.newValue !== null) lockThisTab();
		return;
	}
	if (event.key === PIN_HASH_KEY || event.key === AUTO_LOCK_KEY) notify();
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
 * stay unlocked however long it sits. Off unless chosen.
 *
 * One delay covers both ways the app is left (#145): time **away** and time
 * **untouched**. They are genuinely different waits — a phone in a pocket is not
 * a laptop on a desk — but a second control would ask the couple to reason about
 * a distinction the lock screen never shows them, for a feature whose whole
 * appeal is that nobody has to think about it.
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
 * How much of the auto-lock delay is left, counting from `since`. Zero means the
 * wait is up. Both lock rules read the delay through this, so "how long is a
 * five-minute wait" has one answer and the timer that schedules on it can't
 * disagree with the check that acts on it.
 *
 * A clock that jumped backwards reads as time left rather than time elapsed —
 * deliberately, since a negative gap is not a wait anyone sat through.
 */
export function msLeftOfAutoLock(
	since: number,
	minutes: number,
	at: number = Date.now(),
): number {
	return Math.max(0, since + minutes * 60_000 - at);
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
 * Records that somebody touched this device, for every tab to see (#145).
 *
 * The one thing about the untouched wait that does reach storage, and only
 * because nothing else can: input arrives at one tab, and the tabs that didn't
 * receive it are the ones at risk of locking on top of it. Callers throttle —
 * this is a heartbeat while the app is in use, not a record of each touch.
 */
export function markTouched(at: number = Date.now()): void {
	if (!isPinSet() || getAutoLockMinutes() === AUTO_LOCK_OFF) return;
	localStorage.setItem(TOUCHED_AT_KEY, String(at));
}

/** The last touch any tab on this device reported; 0 when none has. */
function touchedAt(): number {
	const stored = Number(localStorage.getItem(TOUCHED_AT_KEY));
	return Number.isFinite(stored) ? stored : 0;
}

/**
 * Locks if the app was out of sight for longer than the auto-lock delay; call it
 * when the app comes back into view. Returns whether it locked. The away mark is
 * consumed either way, so one trip away can only lock once.
 *
 * A phone that sleeps or an app that gets switched away is what this covers; a
 * window left open in front of you is the other half, and belongs to
 * {@link lockIfUntouchedTooLong}.
 *
 * No `isPinSet` guard, unlike the untouched rule: an away mark only exists
 * because {@link markAway} wrote one, and it won't write without a PIN.
 */
export function lockIfAwayTooLong(at: number = Date.now()): boolean {
	const away = sessionStorage.getItem(AWAY_AT_KEY);
	sessionStorage.removeItem(AWAY_AT_KEY);

	const minutes = getAutoLockMinutes();
	if (away === null || minutes === AUTO_LOCK_OFF || isLocked()) return false;
	if (msLeftOfAutoLock(Number(away), minutes, at) > 0) return false;

	lock();
	return true;
}

/**
 * Locks if nobody has touched the app since `lastTouchedAt` and the auto-lock
 * delay has passed — the desk case (#145). Returns whether it locked.
 *
 * The away rule could never reach this one: a laptop you walked away from
 * without switching apps is still showing the foreground tab, so nothing ever
 * announces a departure and the app sits there uncovered. The same delay is
 * read here against the last touch instead.
 *
 * `lastTouchedAt` is the calling tab's own reading, held in memory rather than
 * kept here, because keeping it would mean writing storage on every pointer
 * move. The device-wide mark {@link markTouched} leaves is the other half, and
 * the later of the two wins: a lock covers every tab, so the tab nobody has
 * touched must not lock on top of the tab somebody is using.
 */
export function lockIfUntouchedTooLong(
	lastTouchedAt: number,
	at: number = Date.now(),
): boolean {
	const minutes = getAutoLockMinutes();
	if (!isPinSet() || minutes === AUTO_LOCK_OFF || isLocked()) return false;
	const since = Math.max(lastTouchedAt, touchedAt());
	if (msLeftOfAutoLock(since, minutes, at) > 0) return false;

	lock();
	return true;
}
