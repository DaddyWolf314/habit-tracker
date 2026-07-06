import { describe, expect, it } from "vitest";
import { anchorElapsedDays, anchorElapsedMs, resetAnchor } from "./anchors.ts";

const DAY = 86_400_000;

describe("anchor reset (handoff §4.5, §4.2 — time-anchored to occurred_at)", () => {
	it("sets the anchor from never-reset to the resetting event's time", () => {
		expect(resetAnchor(null, 1_000)).toBe(1_000);
	});

	it("advances to the most recent qualifying event (later occurred_at wins)", () => {
		expect(resetAnchor(1_000, 5_000)).toBe(5_000);
	});

	it("ignores an out-of-order older reset so replay is order-independent", () => {
		// An amendment backdating an infraction earlier than the last one must not
		// move "since last infraction" backward — the latest event defines it. And
		// because resetAnchor folds by max it is commutative, so a rebuild that
		// replays the log in any order lands on the same anchor value.
		expect(resetAnchor(5_000, 1_000)).toBe(5_000);
	});
});

describe("elapsed-since display (handoff §4.5 — live 'days since')", () => {
	it("is null until the anchor has ever been reset", () => {
		expect(anchorElapsedMs(null, 10_000)).toBeNull();
		expect(anchorElapsedDays(anchorElapsedMs(null, 10_000))).toBeNull();
	});

	it("counts forward from the anchor timestamp", () => {
		expect(anchorElapsedMs(1_000, 61_000)).toBe(60_000);
	});

	it("never goes negative if the clock is behind the anchor", () => {
		expect(anchorElapsedMs(61_000, 1_000)).toBe(0);
	});

	it("floors elapsed milliseconds to whole days for the display", () => {
		expect(anchorElapsedDays(3 * DAY + 5_000)).toBe(3);
	});
});
