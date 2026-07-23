import { describe, expect, it } from "vitest";
import { awaitingKeysFor, eventTypeSchema } from "./event-types.ts";
import { visibilityAllowedForType } from "./visibility.ts";

/**
 * The journaling-capability flag (ADR 0001): it parses off the type schema, and
 * the type-level visibility rule rejects a non-`shared` visibility on a type that
 * is not journaling-capable.
 */

const base = {
	id: "x",
	label: "X",
	log_permission: ["sub"],
};

describe("journaling flag on eventTypeSchema", () => {
	it("defaults to false when omitted (the starter/accountability types)", () => {
		expect(eventTypeSchema.parse(base).journaling).toBe(false);
	});

	it("parses an explicit journaling: true", () => {
		expect(
			eventTypeSchema.parse({ ...base, journaling: true }).journaling,
		).toBe(true);
	});
});

describe("type-level visibility rule", () => {
	it("rejects a non-shared visibility on a non-journaling type", () => {
		const plain = eventTypeSchema.parse(base);
		expect(visibilityAllowedForType(plain, "shared")).toBe(true);
		expect(visibilityAllowedForType(plain, "sealed")).toBe(false);
		expect(visibilityAllowedForType(plain, "secret")).toBe(false);
	});

	it("allows every level on a journaling-capable type", () => {
		const journal = eventTypeSchema.parse({ ...base, journaling: true });
		expect(visibilityAllowedForType(journal, "sealed")).toBe(true);
		expect(visibilityAllowedForType(journal, "secret")).toBe(true);
	});
});

describe("awaiting entries + awaitingKeysFor (ADR 0003)", () => {
	it("parses bare keys and subject-qualified entries side by side", () => {
		const parsed = eventTypeSchema.parse({
			...base,
			awaiting: ["severity", { key: "permitted", subject_role: "sub" }],
		});
		expect(parsed.awaiting).toEqual([
			"severity",
			{ key: "permitted", subject_role: "sub" },
		]);
	});

	it("rejects a qualifier outside the role enum", () => {
		const result = eventTypeSchema.safeParse({
			...base,
			awaiting: [{ key: "permitted", subject_role: "butler" }],
		});
		expect(result.success).toBe(false);
	});

	it("bare keys are always in force; qualified only on a role match", () => {
		const awaiting = [
			"severity",
			{ key: "permitted", subject_role: "sub" as const },
		];
		expect(awaitingKeysFor(awaiting, "sub")).toEqual(["severity", "permitted"]);
		expect(awaitingKeysFor(awaiting, "dom")).toEqual(["severity"]);
		expect(awaitingKeysFor(awaiting, undefined)).toEqual(["severity"]);
	});
});
