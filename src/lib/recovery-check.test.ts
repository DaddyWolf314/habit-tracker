import { describe, expect, it } from "vitest";
import {
	CHECK_WORD_COUNT,
	matchesWordAt,
	pickCheckPositions,
} from "./recovery-check.ts";

const PHRASE =
	"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
const WORDS = PHRASE.split(" ");

/** A stubbed `random` that walks a fixed sequence, so a pick is reproducible. */
function scripted(values: number[]): () => number {
	let i = 0;
	return () => values[i++ % values.length];
}

describe("pickCheckPositions", () => {
	it("asks for the configured number of words by default", () => {
		expect(pickCheckPositions(24)).toHaveLength(CHECK_WORD_COUNT);
	});

	it("picks distinct positions inside the phrase", () => {
		for (let run = 0; run < 200; run++) {
			const picked = pickCheckPositions(24, 3);
			expect(new Set(picked).size).toBe(3);
			for (const position of picked) {
				expect(position).toBeGreaterThanOrEqual(1);
				expect(position).toBeLessThanOrEqual(24);
			}
		}
	});

	it("returns them in phrase order, so the prompt reads top to bottom", () => {
		for (let run = 0; run < 200; run++) {
			const picked = pickCheckPositions(24, 3);
			expect(picked).toEqual([...picked].sort((a, b) => a - b));
		}
	});

	it("never asks for more positions than the phrase has words", () => {
		expect(pickCheckPositions(2, 3)).toEqual([1, 2]);
	});

	it("is a function of the randomness handed to it", () => {
		expect(pickCheckPositions(12, 3, scripted([0]))).toEqual([1, 2, 3]);
		expect(pickCheckPositions(12, 3, scripted([0.9999]))).toEqual([1, 2, 12]);
	});
});

describe("matchesWordAt", () => {
	it("matches the word at a 1-based position", () => {
		expect(matchesWordAt(PHRASE, 1, WORDS[0])).toBe(true);
		expect(matchesWordAt(PHRASE, 12, WORDS[11])).toBe(true);
	});

	it("forgives the case and padding a keyboard adds", () => {
		expect(matchesWordAt(PHRASE, 5, "  Echo ")).toBe(true);
	});

	it("rejects the neighbouring word", () => {
		expect(matchesWordAt(PHRASE, 5, WORDS[5])).toBe(false);
	});

	it("rejects an empty answer", () => {
		expect(matchesWordAt(PHRASE, 5, "   ")).toBe(false);
	});

	it("rejects a position the phrase doesn't have", () => {
		expect(matchesWordAt(PHRASE, 0, WORDS[0])).toBe(false);
		expect(matchesWordAt(PHRASE, 13, "lima")).toBe(false);
	});
});
