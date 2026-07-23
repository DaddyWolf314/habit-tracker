import { describe, expect, it } from "vitest";
import {
	currentRule,
	latestVersion,
	type Rule,
	ruleFromVersion,
	ruleSchema,
	ruleVersionSchema,
	versionedRuleSchema,
	versionFromDefinition,
} from "./rules.ts";

/**
 * Schema round-trips for the effective-dated rule shape (ADR 0002, spec #64).
 * The versioning schema is the seam the resolver, validation, and reconciliation
 * slices build on, so these pin the shape: a version is a definition stamped with
 * a log-time; a versioned rule is a stable id over an append-only history; and the
 * flat `Rule` the engine reads stays a valid single-definition shape.
 */

const increment = { verb: "increment_counter", counter: "demerits" } as const;

describe("ruleSchema (flat read shape)", () => {
	it("still parses a plain id + definition and defaults enabled to true", () => {
		const parsed = ruleSchema.parse({
			id: "custom-late",
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [increment],
		});
		expect(parsed).toMatchObject({
			id: "custom-late",
			enabled: true,
			effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
		});
	});

	it("carries no effective_from — the flat shape is version-agnostic", () => {
		const parsed = ruleSchema.parse({
			id: "r",
			condition: { type: "note", metadata: {} },
			effects: [increment],
		});
		expect("effective_from" in parsed).toBe(false);
	});
});

describe("ruleVersionSchema (one effective-dated revision)", () => {
	it("is a definition stamped with the log-time it takes force", () => {
		const parsed = ruleVersionSchema.parse({
			effective_from: 1_700_000_000_000,
			condition: { type: "ritual_completed", metadata: {} },
			effects: [increment],
		});
		expect(parsed.effective_from).toBe(1_700_000_000_000);
		expect(parsed.enabled).toBe(true);
	});

	it("carries no id — identity lives on the owning rule, not the revision", () => {
		const parsed = ruleVersionSchema.parse({
			effective_from: 0,
			condition: { type: "note", metadata: {} },
			effects: [increment],
		});
		expect("id" in parsed).toBe(false);
	});

	it("requires effective_from", () => {
		expect(
			ruleVersionSchema.safeParse({
				condition: { type: "note", metadata: {} },
				effects: [increment],
			}).success,
		).toBe(false);
	});

	it("captures a disable as an effective-dated revision, not a deletion", () => {
		const parsed = ruleVersionSchema.parse({
			effective_from: 42,
			enabled: false,
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [increment],
		});
		expect(parsed.enabled).toBe(false);
	});
});

describe("versionedRuleSchema (stored history)", () => {
	it("round-trips a single-version custom rule with default adopted=false", () => {
		const input = {
			id: "custom-1",
			origin: "custom" as const,
			versions: [
				{
					effective_from: 0,
					condition: { type: "note", metadata: {} },
					effects: [increment],
				},
			],
		};
		const parsed = versionedRuleSchema.parse(input);
		expect(parsed.adopted).toBe(false);
		expect(parsed.versions).toHaveLength(1);
		// Re-parsing the parsed output is stable (round-trip).
		expect(versionedRuleSchema.parse(parsed)).toEqual(parsed);
	});

	it("round-trips a multi-version adopted pack rule", () => {
		const parsed = versionedRuleSchema.parse({
			id: "R2",
			origin: "pack",
			adopted: true,
			versions: [
				{
					effective_from: 0,
					condition: { type: "ritual_completed", metadata: { late: true } },
					effects: [{ verb: "increment_counter", counter: "demerits", by: 1 }],
				},
				{
					effective_from: 1_000,
					condition: { type: "ritual_completed", metadata: { late: true } },
					effects: [{ verb: "increment_counter", counter: "demerits", by: 2 }],
				},
			],
		});
		expect(parsed.origin).toBe("pack");
		expect(parsed.adopted).toBe(true);
		expect(parsed.versions.map((v) => v.effective_from)).toEqual([0, 1_000]);
	});

	it("rejects an empty version history — a rule always has a definition", () => {
		expect(
			versionedRuleSchema.safeParse({
				id: "x",
				origin: "custom",
				versions: [],
			}).success,
		).toBe(false);
	});

	it("rejects an unknown origin", () => {
		expect(
			versionedRuleSchema.safeParse({
				id: "x",
				origin: "shipped",
				versions: [
					{
						effective_from: 0,
						condition: { type: "note", metadata: {} },
						effects: [increment],
					},
				],
			}).success,
		).toBe(false);
	});
});

describe("flat and versioned shapes stay aligned", () => {
	it("a version's definition fields are exactly a Rule minus its id", () => {
		const version = ruleVersionSchema.parse({
			effective_from: 5,
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [increment],
		});
		// Stamping the version onto an id yields a valid flat Rule — the shape the
		// engine reads once the resolver has picked a version for a log-time.
		const { effective_from, ...definition } = version;
		const flat: Rule = ruleSchema.parse({ id: "custom-late", ...definition });
		expect(flat.condition).toEqual(version.condition);
		expect(flat.effects).toEqual(version.effects);
		expect(flat.enabled).toBe(version.enabled);
	});

	it("ruleFromVersion and versionFromDefinition are inverses around a stamp", () => {
		const version = ruleVersionSchema.parse({
			effective_from: 5,
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [increment],
		});
		const flat = ruleFromVersion("custom-late", version);
		expect(versionFromDefinition(flat, 5)).toEqual(version);
	});
});

describe("latestVersion / currentRule (the one 'current definition' seam)", () => {
	const versioned = versionedRuleSchema.parse({
		id: "R2",
		origin: "pack",
		adopted: true,
		versions: [
			{
				effective_from: 0,
				condition: { type: "ritual_completed", metadata: {} },
				effects: [increment],
			},
			{
				effective_from: 100,
				condition: { type: "ritual_completed", metadata: { late: true } },
				effects: [{ ...increment, by: 2 }],
				enabled: false,
			},
		],
	});

	it("picks the version with the greatest effective_from, regardless of order", () => {
		expect(latestVersion(versioned).effective_from).toBe(100);
		const reversed = {
			...versioned,
			versions: [...versioned.versions].reverse(),
		};
		expect(latestVersion(reversed).effective_from).toBe(100);
	});

	it("a single-version rule's current definition is that version", () => {
		const single = versionedRuleSchema.parse({
			id: "custom-x",
			origin: "custom",
			versions: [
				{
					effective_from: 7,
					condition: { type: "note", metadata: {} },
					effects: [increment],
				},
			],
		});
		expect(latestVersion(single).effective_from).toBe(7);
		expect(currentRule(single).id).toBe("custom-x");
	});

	it("flattens the latest version to the flat Rule the engine and UI read", () => {
		expect(currentRule(versioned)).toEqual({
			id: "R2",
			condition: { type: "ritual_completed", metadata: { late: true } },
			effects: [{ verb: "increment_counter", counter: "demerits", by: 2 }],
			enabled: false,
		});
	});
});
