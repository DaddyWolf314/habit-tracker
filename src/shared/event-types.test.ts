import { describe, expect, it } from "vitest";
import { eventTypeSchema } from "./event-types.ts";
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
