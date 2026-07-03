/**
 * Isomorphic crypto helpers (Workers runtime + browser + Node 22). Uses only
 * WebCrypto and btoa/atob so the same code runs server- and client-side.
 *
 * The identity model (handoff §2): a client generates a high-entropy secret and
 * presents it as the bearer credential. The server only ever stores a hash of
 * it — treat like a password hash — and never persists the plaintext.
 */

/** URL-safe base64 (no padding) of raw bytes. */
export function bytesToBase64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Inverse of {@link bytesToBase64url}. */
export function base64urlToBytes(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** `n` cryptographically random bytes. */
export function randomBytes(n: number): Uint8Array {
	const bytes = new Uint8Array(n);
	crypto.getRandomValues(bytes);
	return bytes;
}

/** A fresh random bearer token (256-bit by default), URL-safe. */
export function randomToken(byteLength = 32): string {
	return bytesToBase64url(randomBytes(byteLength));
}

/**
 * SHA-256 of a string or bytes, as URL-safe base64. This is how a bearer token
 * becomes the `credential_hash` stored in the routing DB and the DO.
 */
export async function sha256Base64url(
	input: string | Uint8Array,
): Promise<string> {
	const data =
		typeof input === "string" ? new TextEncoder().encode(input) : input;
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return bytesToBase64url(new Uint8Array(digest));
}
