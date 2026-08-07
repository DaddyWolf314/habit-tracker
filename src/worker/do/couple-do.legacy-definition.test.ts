import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rungsReached } from "#/shared/counters.ts";
import { type ActiveCouple, activeCouple, DOM } from "./harness.ts";

/**
 * A counter definition **stored before a field existed**, read back through the
 * DO (#193, #194).
 *
 * `counters.definition` is a JSON mirror of the latest version, written by
 * whatever the schema was on the day it was written and read back with a cast.
 * That cast is the lie these cover: every field the schema has *added* since —
 * `target_direction`, `modify_permission`, and `rungs` — is absent from a row a
 * couple wrote before it, so the cast hands the client a `CounterDefinition`
 * whose declared-non-optional fields are `undefined`. `rungs` is the one that
 * bites, because Today folds it with `rungsReached`, and `undefined.filter` is a
 * blank screen rather than a missing banner.
 *
 * The version read seam never had the bug — `versionFromCounterDefinition`
 * parses — so the fix is to make the mirror read the same way, and the assertion
 * here is deliberately "the same shape a fresh write produces", not "rungs is an
 * array": the point is that a legacy row and a today row are indistinguishable
 * downstream.
 */

const START = Date.parse("2026-01-07T09:00:00.000Z");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});
afterEach(() => {
	vi.useRealTimers();
});

/**
 * Rewrites a counter's stored mirror as a pre-#193 writer would have left it:
 * the fields the schema had then, and nothing the schema has gained since. The
 * version row is left alone, because a legacy couple has one of those too and it
 * is not what broke.
 */
function storeLegacyDefinition(couple: ActiveCouple, id: string): void {
	couple.db.prepare(`UPDATE counters SET definition = ? WHERE id = ?`).run(
		JSON.stringify({
			id,
			name: "Demerits",
			valence: "negative",
			reset: "never",
		}),
		id,
	);
}

describe("a counter definition stored before rungs existed", () => {
	it("reads back with the fields the schema has since gained", async () => {
		const couple = await activeCouple();
		storeLegacyDefinition(couple, "demerits");

		const counter = (await couple.do.listCounters(DOM)).find(
			(row) => row.id === "demerits",
		);

		expect(counter).toBeDefined();
		expect(counter?.rungs).toEqual([]);
		expect(counter?.target_direction).toBe("floor");
		expect(counter?.modify_permission).toEqual(["dom", "sub", "switch"]);
	});

	it("survives the fold Today runs over it", async () => {
		const couple = await activeCouple();
		storeLegacyDefinition(couple, "demerits");

		const counters = await couple.do.listCounters(DOM);

		// Exactly what `RungsPanel` does with the list, which is where the deployed
		// app threw "Cannot read properties of undefined (reading 'filter')".
		expect(() =>
			counters.flatMap((counter) => rungsReached(counter.rungs, counter.value)),
		).not.toThrow();
	});
});
