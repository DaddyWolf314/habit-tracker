/**
 * ULID generation (isomorphic: Workers runtime, browser, Node 22). A ULID is a
 * 48-bit millisecond timestamp followed by 80 bits of randomness, Crockford
 * base32, 26 chars. Two properties earn its place as the event id (handoff
 * §4.1): it is lexicographically sortable by creation time — so the log's
 * natural order is chronological without a separate sequence — and it carries
 * enough entropy to avoid collisions within a single millisecond.
 */

// Crockford base32 — no I, L, O, U to avoid transcription ambiguity.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
	let time = now;
	let out = "";
	for (let i = TIME_LEN - 1; i >= 0; i--) {
		out = ENCODING[time % 32] + out;
		time = Math.floor(time / 32);
	}
	return out;
}

function encodeRandom(): string {
	const bytes = new Uint8Array(RANDOM_LEN);
	crypto.getRandomValues(bytes);
	let out = "";
	// Each byte contributes one base32 char (we use the low 5 bits); 16 chars.
	for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[bytes[i] & 0x1f];
	return out;
}

/** A fresh ULID for the given time (defaults to now). */
export function ulid(now: number = Date.now()): string {
	return encodeTime(now) + encodeRandom();
}
