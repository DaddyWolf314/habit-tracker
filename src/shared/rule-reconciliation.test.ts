import { describe, expect, it } from "vitest";
import { reconcilePack } from "./rule-reconciliation.ts";
import type { Rule, VersionedRule } from "./rules.ts";

/**
 * Adopt-on-edit reconciliation (ADR 0002, spec #64). Pure-function tests, no DO:
 * given a shipped pack and a couple's installed set, assert adopted rules are
 * skipped, un-adopted pack rules whose definition changed are upserted forward,
 * and brand-new pack rules are added.
 */

const SEED = 0;
const BUMP = 1_000;

function packRule(id: string, by: number): Rule {
	return {
		id,
		condition: { type: "ritual_completed", metadata: { late: true } },
		effects: [{ verb: "increment_counter", counter: "demerits", by }],
		enabled: true,
	};
}

function installed(
	id: string,
	by: number,
	partial: Partial<VersionedRule> = {},
): VersionedRule {
	const { id: _drop, ...def } = packRule(id, by);
	return {
		id,
		origin: "pack",
		adopted: false,
		versions: [{ effective_from: SEED, ...def }],
		...partial,
	};
}

describe("reconcilePack — initial seed (empty installed set)", () => {
	it("adds every pack rule as a single-version pack rule", () => {
		const pack = [packRule("R1", 1), packRule("R2", 1)];
		const r = reconcilePack(pack, [], SEED);
		expect(r.added.map((v) => v.id)).toEqual(["R1", "R2"]);
		expect(
			r.added.every((v) => v.origin === "pack" && v.adopted === false),
		).toBe(true);
		expect(r.added[0]?.versions).toHaveLength(1);
		expect(r.added[0]?.versions[0]?.effective_from).toBe(SEED);
		expect(r.upserted).toEqual([]);
		expect(r.skipped).toEqual([]);
	});
});

describe("reconcilePack — bump against an installed set", () => {
	it("adds a brand-new pack rule stamped at the bump time", () => {
		const pack = [packRule("R1", 1), packRule("R99", 1)];
		const r = reconcilePack(pack, [installed("R1", 1)], BUMP);
		expect(r.added.map((v) => v.id)).toEqual(["R99"]);
		expect(r.added[0]?.versions[0]?.effective_from).toBe(BUMP);
		expect(r.upserted).toEqual([]);
	});

	it("upserts an un-adopted pack rule whose definition changed, forward-only", () => {
		const pack = [packRule("R2", 2)]; // shipped bumps +1 -> +2
		const r = reconcilePack(pack, [installed("R2", 1)], BUMP);
		expect(r.upserted).toHaveLength(1);
		const up = r.upserted[0];
		expect(up?.id).toBe("R2");
		// A new version to append, effective from the bump — not a replace.
		expect(up?.version.effective_from).toBe(BUMP);
		expect(up?.version.effects).toEqual([
			{ verb: "increment_counter", counter: "demerits", by: 2 },
		]);
		expect(r.added).toEqual([]);
		expect(r.skipped).toEqual([]);
	});

	it("no-ops an un-adopted pack rule whose definition is unchanged", () => {
		const pack = [packRule("R2", 1)];
		const r = reconcilePack(pack, [installed("R2", 1)], BUMP);
		expect(r.added).toEqual([]);
		expect(r.upserted).toEqual([]);
		expect(r.skipped).toEqual([]);
	});

	it("skips an adopted rule and never overwrites it", () => {
		const pack = [packRule("R2", 2)];
		const adopted = installed("R2", 5, { adopted: true }); // couple tuned to +5
		const r = reconcilePack(pack, [adopted], BUMP);
		expect(r.upserted).toEqual([]);
		expect(r.added).toEqual([]);
		expect(r.skipped).toEqual([{ id: "R2", changedUpstream: true }]);
	});

	it("flags changedUpstream=false for an adopted rule the pack did not change", () => {
		const pack = [packRule("R2", 1)];
		const adopted = installed("R2", 1, {
			adopted: true,
			versions: [
				{
					effective_from: SEED,
					condition: { type: "ritual_completed", metadata: { late: true } },
					effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
					enabled: false, // adopted via a disable, but same definition otherwise
				},
			],
		});
		// enabled differs, so this IS a change — sanity that enabled participates.
		expect(reconcilePack(pack, [adopted], BUMP).skipped).toEqual([
			{ id: "R2", changedUpstream: true },
		]);

		// Truly identical adopted rule -> changedUpstream false.
		const identical = installed("R2", 1, { adopted: true });
		expect(reconcilePack(pack, [identical], BUMP).skipped).toEqual([
			{ id: "R2", changedUpstream: false },
		]);
	});

	it("compares the pack against the latest version of a multi-version rule", () => {
		const pack = [packRule("R2", 3)];
		const multi = installed("R2", 1, {
			versions: [
				{
					effective_from: SEED,
					condition: { type: "ritual_completed", metadata: { late: true } },
					effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
					enabled: true,
				},
				{
					effective_from: 500,
					condition: { type: "ritual_completed", metadata: { late: true } },
					effects: [{ verb: "increment_counter", counter: "demerits", by: 3 }],
					enabled: true,
				},
			],
		});
		// Latest is already +3, matching the pack -> no-op.
		expect(reconcilePack(pack, [multi], BUMP).upserted).toEqual([]);
	});

	it("ignores custom rules the couple authored", () => {
		const pack = [packRule("R1", 1)];
		const custom: VersionedRule = {
			id: "custom-late",
			origin: "custom",
			adopted: false,
			versions: [
				{
					effective_from: SEED,
					condition: { type: "note", metadata: {} },
					effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
					enabled: true,
				},
			],
		};
		const r = reconcilePack(pack, [installed("R1", 1), custom], BUMP);
		expect(r.added).toEqual([]);
		expect(r.upserted).toEqual([]);
		expect(r.skipped).toEqual([]);
	});

	it("is order-independent in the definition comparison (metadata key order)", () => {
		const pack: Rule[] = [
			{
				id: "R9",
				condition: {
					type: "infraction",
					metadata: { severity: "minor", self_reported: false },
				},
				effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
				enabled: true,
			},
		];
		const inst: VersionedRule = {
			id: "R9",
			origin: "pack",
			adopted: false,
			versions: [
				{
					effective_from: SEED,
					condition: {
						type: "infraction",
						// same equalities, keys in the other order
						metadata: { self_reported: false, severity: "minor" },
					},
					effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
					enabled: true,
				},
			],
		};
		expect(reconcilePack(pack, [inst], BUMP).upserted).toEqual([]);
	});
});
