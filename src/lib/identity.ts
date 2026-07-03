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
const SECRET_BYTES = 32; // 256-bit → 24-word phrase

/** The persisted secret (base64url), or null on a fresh device. */
export function getSecret(): string | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(STORAGE_KEY);
}

export function hasIdentity(): boolean {
	return getSecret() !== null;
}

export function storeSecret(secret: string): void {
	localStorage.setItem(STORAGE_KEY, secret);
}

export function clearSecret(): void {
	localStorage.removeItem(STORAGE_KEY);
}

/** Bearer token for the `Authorization` header — the secret itself. */
export function getBearer(): string | null {
	return getSecret();
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
