import { sha256Base64url } from "./crypto.ts";

/**
 * Client-side PIN lock (handoff §3.5, #42) — a discretion feature. It keeps a
 * casual glance out of the app on an unlocked, shared, or borrowed device; it is
 * deliberately *not* a cryptographic boundary against someone who fully controls
 * the device (the relationship data is protected by the bearer credential, not
 * this PIN). Only a hash of the PIN is stored locally; the plaintext never is.
 *
 * "Locked" is per browser session: setting/verifying a PIN unlocks the current
 * session, and the lock re-engages on the next fresh load while a PIN is set.
 */

const PIN_HASH_KEY = "strawberry.pin_hash";
const UNLOCKED_KEY = "strawberry.pin_unlocked";

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

/** Removes the PIN lock entirely. */
export function clearPin(): void {
	localStorage.removeItem(PIN_HASH_KEY);
	sessionStorage.removeItem(UNLOCKED_KEY);
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
}

/** True when a PIN is set and this session has not been unlocked yet. */
export function isLocked(): boolean {
	return isPinSet() && sessionStorage.getItem(UNLOCKED_KEY) !== "1";
}
