import { describe, expect, it } from "vitest";
import {
	type CounterVersion,
	countersEffectiveAt,
	latestCounterVersion,
	sameCounterPolicy,
	type VersionedCounter,
	versionFromCounterDefinition,
} from "./counters.ts";

/**
 * Effective-dated counter definitions (ADR 0013) — the resolution seam a rebuild
 * folds each past rollover through.
 *
 * The clock here is the one thing worth stating twice: a rule version resolves at
 * an event's log-time and an Agreement version at its `occurred_at`, but a
 * counter's policy is read by a *system job*, so the moment that governs is the
 * boundary being folded. These pin that, not the shared `versionInForceAt`
 * mechanism, which `engine.versioning.test.ts` already covers.
 */

function version(
	effectiveFrom: number,
	overrides: Partial<Omit<CounterVersion, "effective_from">> = {},
): CounterVersion {
	return versionFromCounterDefinition(
		{
			name: "Rituals completed today",
			valence: "positive",
			daily_target: 1,
			reset: "daily",
			modify_permission: ["dom", "sub", "switch"],
			...overrides,
		},
		effectiveFrom,
	);
}

function counter(versions: CounterVersion[]): VersionedCounter {
	return {
		id: "rituals_completed_today",
		value: 0,
		updated_at: null,
		versions,
	};
}

describe("countersEffectiveAt", () => {
	it("resolves the policy in force at the boundary being folded", () => {
		const counters = [
			counter([version(0), version(5_000, { daily_target: 5 })]),
		];
		expect(countersEffectiveAt(counters, 4_999)[0]?.daily_target).toBe(1);
		expect(countersEffectiveAt(counters, 5_000)[0]?.daily_target).toBe(5);
	});

	it("takes force at its own instant, not the one after", () => {
		// A boundary landing exactly on an edit folds under the new policy — the
		// same inclusive tie-break rule versions use.
		const counters = [
			counter([version(0), version(5_000, { daily_target: 5 })]),
		];
		expect(countersEffectiveAt(counters, 5_000)[0]?.daily_target).toBe(5);
	});

	it("omits a counter that did not exist yet", () => {
		// Not the same as existing and unmet: a rollover before the counter was
		// created has nothing to fold, and a streak pointing at it folds nothing.
		const counters = [counter([version(5_000)])];
		expect(countersEffectiveAt(counters, 4_999)).toEqual([]);
		expect(countersEffectiveAt(counters, 5_000)).toHaveLength(1);
	});

	it("carries the id back onto the resolved definition", () => {
		const resolved = countersEffectiveAt([counter([version(0)])], 1_000);
		expect(resolved[0]?.id).toBe("rituals_completed_today");
	});

	it("is order-independent across the version list", () => {
		const ascending = [
			counter([version(0), version(5_000, { daily_target: 5 })]),
		];
		const descending = [
			counter([version(5_000, { daily_target: 5 }), version(0)]),
		];
		expect(countersEffectiveAt(ascending, 9_999)).toEqual(
			countersEffectiveAt(descending, 9_999),
		);
	});
});

describe("latestCounterVersion", () => {
	it("picks the greatest effective_from regardless of order", () => {
		const subject = counter([version(5_000, { daily_target: 5 }), version(0)]);
		expect(latestCounterVersion(subject).daily_target).toBe(5);
	});
});

describe("sameCounterPolicy", () => {
	it("ignores when each version took force", () => {
		// What keeps a pack bump from appending a version per counter that says
		// nothing changed.
		expect(sameCounterPolicy(version(0), version(9_000))).toBe(true);
	});

	it("sees a changed target", () => {
		expect(sameCounterPolicy(version(0), version(0, { daily_target: 5 }))).toBe(
			false,
		);
	});

	it("sees a changed name, which versions like the rest of the policy", () => {
		// A counter's name is displayed against its own history (the reason ADR 0009
		// gave for rule names), so a rename is a real new version.
		expect(sameCounterPolicy(version(0), version(0, { name: "Rituals" }))).toBe(
			false,
		);
	});
});
