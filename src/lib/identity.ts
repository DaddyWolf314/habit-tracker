import {
	entropyToMnemonic,
	mnemonicToEntropy,
	validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { base64urlToBytes, bytesToBase64url, randomBytes } from "./crypto.ts";

/**
 * Client-side root identity (handoff §2). The secret never leaves the device
 * except as the bearer credential; here it is stored as URL-safe base64 and
 * shown to the user as a 24-word BIP39 recovery phrase — framed as the only
 * key, because the server cannot reset what it never knew.
 */
const STORAGE_KEY = "strawberry.secret";
/**
 * A per-device token (handoff §2) adopted on a device that was linked from
 * another one, rather than seeded with the root phrase. It authenticates like
 * any bearer, but it is not the root secret — so a device holding only this has
 * no recovery phrase to show, which is the point: the root stays cold.
 */
const DEVICE_TOKEN_KEY = "strawberry.device_token";
const SECRET_BYTES = 32; // 256-bit → 24-word phrase

/** The persisted root secret (base64url), or null on a device without the phrase. */
export function getSecret(): string | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(STORAGE_KEY);
}

/** The persisted device token, or null on a root/recovery-phrase device. */
export function getDeviceToken(): string | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(DEVICE_TOKEN_KEY);
}

/** True once this device holds any bearer — a root secret or a device token. */
export function hasIdentity(): boolean {
	return getBearer() !== null;
}

/** True only on a device that holds the root secret and can show the phrase. */
export function hasRootSecret(): boolean {
	return getSecret() !== null;
}

export function storeSecret(secret: string): void {
	localStorage.setItem(STORAGE_KEY, secret);
}

/** Adopts a minted device token as this device's bearer (no root secret). */
export function storeDeviceToken(token: string): void {
	localStorage.setItem(DEVICE_TOKEN_KEY, token);
}

/** Clears every credential this device holds — both the secret and any token. */
export function clearCredentials(): void {
	localStorage.removeItem(STORAGE_KEY);
	localStorage.removeItem(DEVICE_TOKEN_KEY);
}

/**
 * Bearer token for the `Authorization` header. A device token takes precedence
 * over the root secret, so a linked device authenticates as its own revocable
 * credential even if a root secret is somehow also present.
 */
export function getBearer(): string | null {
	return getDeviceToken() ?? getSecret();
}

/** Generates a fresh secret without persisting it (persist after the ceremony). */
export function generateSecret(): { secret: string; mnemonic: string } {
	const entropy = randomBytes(SECRET_BYTES);
	return {
		secret: bytesToBase64url(entropy),
		mnemonic: entropyToMnemonic(entropy, wordlist),
	};
}

/** The recovery phrase for a stored secret (for "show my phrase again"). */
export function mnemonicForSecret(secret: string): string {
	return entropyToMnemonic(base64urlToBytes(secret), wordlist);
}

/**
 * Recovers a secret from a typed recovery phrase. Throws if the phrase fails the
 * BIP39 checksum, so a mistyped word is caught before it becomes a wrong bearer.
 */
export function secretFromMnemonic(mnemonic: string): string {
	const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
	if (!validateMnemonic(normalized, wordlist)) {
		throw new Error(
			"That recovery phrase isn't valid — check the words and spacing.",
		);
	}
	return bytesToBase64url(mnemonicToEntropy(normalized, wordlist));
}
