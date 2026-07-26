/**
 * The confirmation step of the recovery-phrase ceremony (handoff §2, §9.1). The
 * phrase is unrecoverable by design — the server holds only a hash, so nobody
 * can reset it — which makes "I've written it down" too weak a gate to be the
 * only one. Asking for a few words back is the standard proof that the phrase
 * left the screen and landed somewhere.
 *
 * The pick is a UX check, not a secret: `Math.random` is enough, and the
 * randomness is a parameter so a caller (or a test) can pin it.
 */

/** How many words the confirmation step asks for. Enough to catch a screenshot-and-move-on, few enough to stay tolerable. */
export const CHECK_WORD_COUNT = 3;

/**
 * `howMany` distinct 1-based word positions, in phrase order — a short phrase
 * simply yields all of its positions rather than looping forever looking for
 * one more.
 */
export function pickCheckPositions(
	wordCount: number,
	howMany: number = CHECK_WORD_COUNT,
	random: () => number = Math.random,
): number[] {
	const pool = Array.from({ length: wordCount }, (_, i) => i + 1);
	const take = Math.min(howMany, pool.length);
	// Partial Fisher-Yates: draws without replacement, so no position repeats.
	for (let i = 0; i < take; i++) {
		const j = i + Math.floor(random() * (pool.length - i));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, take).sort((a, b) => a - b);
}

/**
 * Whether a typed answer is the phrase's word at `position` (1-based). Case and
 * surrounding whitespace are forgiven — a phone's keyboard adds both, and the
 * point is to check the transcription, not the typing.
 */
export function matchesWordAt(
	mnemonic: string,
	position: number,
	answer: string,
): boolean {
	const word = mnemonic.trim().split(/\s+/)[position - 1];
	if (word === undefined) return false;
	return answer.trim().toLowerCase() === word.toLowerCase();
}
