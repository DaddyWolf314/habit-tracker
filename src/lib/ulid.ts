/**
 * ULID generation (isomorphic: Workers runtime, browser, Node 22). A ULID is a
 * 48-bit millisecond timestamp followed by 80 bits of randomness, Crockford
 * base32, 26 chars. Two properties earn its place as the event id (handoff
 * §4.1): it is lexicographically sortable by creation time — so the log's
 * natural order is chronological without a separate sequence — and it carries
 * enough entropy to avoid collisions within a single millisecond.
 *
 * Generation is *monotonic*: two ULIDs minted in the same millisecond are still
 * strictly increasing (the random field is incremented rather than re-rolled).
 * This is load-bearing — projection replay tie-breaks equal-`logged_at` events
 * by id, so id order must equal append order or a rebuilt counter could diverge
 * from the live cache (e.g. a reset and an adjustment logged in the same ms).
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

// Monotonic state: the last timestamp minted and the base32 indices (0–31) of
// its random field, so a same-ms mint can increment rather than re-roll.
let lastTime = -1;
let lastRandom: number[] = [];

function freshRandom(): number[] {
	const bytes = new Uint8Array(RANDOM_LEN);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b & 0x1f);
}

/** Increments the base32 random field in place, carrying from the low end. */
function incrementRandom(random: number[]): void {
	for (let i = RANDOM_LEN - 1; i >= 0; i--) {
		if (random[i] < 31) {
			random[i]++;
			return;
		}
		random[i] = 0; // carry
	}
	// Overflowed all 80 bits in one ms (astronomically unlikely) — re-seed.
	const reseeded = freshRandom();
	for (let i = 0; i < RANDOM_LEN; i++) random[i] = reseeded[i];
}

/** A fresh, monotonic ULID for the given time (defaults to now). */
export function ulid(now: number = Date.now()): string {
	if (now <= lastTime) {
		incrementRandom(lastRandom);
	} else {
		lastTime = now;
		lastRandom = freshRandom();
	}
	const random = lastRandom.map((i) => ENCODING[i]).join("");
	return encodeTime(now) + random;
}
