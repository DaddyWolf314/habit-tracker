import { describe, expect, it } from "vitest";
import {
	awaitingKeysFor,
	checkMetadataValue,
	type EventType,
	eventTypeSchema,
	metadataFieldSchema,
	type OptionAddition,
	optionLabel,
	optionTokenSchema,
	toOptionToken,
	withAddedOptions,
} from "./event-types.ts";
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

describe("the `text` metadata kind (ADR 0005)", () => {
	const field = (max_length?: number) =>
		metadataFieldSchema.parse({
			kind: "text",
			label: "Task",
			set_permission: ["dom"],
			...(max_length === undefined ? {} : { max_length }),
		});

	it("parses with an optional max_length, and rejects a non-positive one", () => {
		expect(field(80)).toMatchObject({ kind: "text", max_length: 80 });
		expect(field()).not.toHaveProperty("max_length");
		expect(
			metadataFieldSchema.safeParse({
				kind: "text",
				label: "Task",
				set_permission: ["dom"],
				max_length: 0,
			}).success,
		).toBe(false);
	});

	it("accepts a string within the length, rejects a longer one", () => {
		expect(checkMetadataValue("task_name", field(4), "dish")).toBeNull();
		expect(checkMetadataValue("task_name", field(4), "dishes")).toContain(
			"too long",
		);
		// No max_length means no ceiling — the field is still a label by intent,
		// but the schema only enforces what it was given.
		expect(checkMetadataValue("task_name", field(), "dishes")).toBeNull();
	});

	it("rejects a non-string value", () => {
		// The DO's log-time switch returns void, so an unhandled kind would accept
		// anything at all; this is the case that regression guards.
		expect(checkMetadataValue("task_name", field(80), 7)).toContain(
			"must be text",
		);
		expect(checkMetadataValue("task_name", field(80), true)).toContain(
			"must be text",
		);
	});
});

/**
 * Option display copy (#155, ADR 0008). The stored value is a machine token and
 * `optionLabel` is the one path from it to the word a person reads, so the rungs
 * matter more than any single label: pack copy, then a de-slug, and never a bare
 * token with underscores in it.
 */
describe("optionLabel", () => {
	const enumField = (option_labels?: Record<string, string>) =>
		metadataFieldSchema.parse({
			kind: "enum",
			options: ["exceeded", "met", "partial"],
			label: "Quality",
			set_permission: ["dom"],
			...(option_labels === undefined ? {} : { option_labels }),
		});

	it("prefers the declared copy for the option", () => {
		const field = enumField({ exceeded: "Beyond what was asked" });
		expect(optionLabel(field, "exceeded")).toBe("Beyond what was asked");
	});

	it("de-slugs an option the copy doesn't cover", () => {
		// Partial copy is legal — a couple's own enum may carry none at all — so an
		// uncovered option has to read as words rather than falling back to the
		// token that made #155 a bug in the first place.
		const field = enumField({ exceeded: "Beyond what was asked" });
		expect(optionLabel(field, "met")).toBe("met");
		expect(optionLabel(enumField(), "met")).toBe("met");
		expect(
			optionLabel(
				metadataFieldSchema.parse({
					kind: "enum",
					options: ["wants_conversation"],
					label: "Flag",
					set_permission: ["sub"],
				}),
				"wants_conversation",
			),
		).toBe("wants conversation");
	});

	it("leaves a non-enum field's options alone", () => {
		// The controls fold booleans into the same option list (`yes`/`no`); a
		// boolean carries no copy, so it must read exactly as it did before.
		const bool = metadataFieldSchema.parse({
			kind: "boolean",
			label: "Late?",
			set_permission: ["sub"],
		});
		expect(optionLabel(bool, "yes")).toBe("yes");
	});
});

/**
 * The overlay merge (#185, ADR 0014). These are the shape rules the DO's read
 * seam relies on; the consumers that would otherwise refuse a couple's word —
 * log validation, amendment validation, rule validation, `seedDefaults` — are
 * covered end to end in `worker/do/couple-do.type-options.test.ts`.
 *
 * The theme they share is degradation. An overlay outlives the definition it
 * rides on, so every case where the pack has moved underneath it resolves to
 * "inert" — never a throw, and never a corrupted field.
 */
describe("withAddedOptions", () => {
	const actType = eventTypeSchema.parse({
		id: "act",
		label: "Act",
		log_permission: ["sub"],
		metadata: {
			act: {
				kind: "enum",
				options: ["impact", "oral"],
				option_labels: { impact: "Impact", oral: "Oral" },
				label: "Act",
				set_permission: ["sub"],
			},
			session_id: { kind: "ref", label: "Session", set_permission: ["sub"] },
		},
	});
	const added = (over: Partial<OptionAddition> = {}): OptionAddition => ({
		type_id: "act",
		field_key: "act",
		option: "aftercare",
		label: "Aftercare",
		...over,
	});

	function options(type: EventType, key = "act"): string[] {
		const field = type.metadata[key];
		return field?.kind === "enum" ? field.options : [];
	}

	function enumOf(type: EventType, key = "act") {
		const field = type.metadata[key];
		if (field?.kind !== "enum") throw new Error(`${key} is not an enum`);
		return field;
	}

	it("appends the couple's options after the pack's, in the order given", () => {
		const merged = withAddedOptions(actType, [
			added(),
			added({ option: "worship", label: "Worship" }),
		]);
		expect(options(merged)).toEqual(["impact", "oral", "aftercare", "worship"]);
	});

	it("merges the copy so optionLabel resolves a couple's word", () => {
		const field = enumOf(withAddedOptions(actType, [added()]));
		expect(optionLabel(field, "aftercare")).toBe("Aftercare");
		expect(optionLabel(field, "impact")).toBe("Impact");
	});

	it("de-slugs an addition with no label of its own", () => {
		const merged = withAddedOptions(actType, [
			added({ option: "after_care", label: undefined }),
		]);
		expect(optionLabel(enumOf(merged), "after_care")).toBe("after care");
	});

	it("does not mutate the pack definition it was given", () => {
		withAddedOptions(actType, [added()]);
		expect(options(actType)).toEqual(["impact", "oral"]);
	});

	it("ignores additions for another type", () => {
		const merged = withAddedOptions(actType, [added({ type_id: "orgasm" })]);
		expect(merged).toBe(actType);
	});

	it("is inert when the pack has since dropped the field", () => {
		const merged = withAddedOptions(actType, [added({ field_key: "gone" })]);
		expect(options(merged)).toEqual(["impact", "oral"]);
	});

	it("is inert when the pack has since changed the field's kind", () => {
		const merged = withAddedOptions(actType, [
			added({ field_key: "session_id" }),
		]);
		expect(merged.metadata.session_id.kind).toBe("ref");
	});

	it("yields to a pack that has since shipped the same option", () => {
		// Position and copy are the pack's: it owns the option now, so a bump that
		// relabels it wins over a label typed before the option existed.
		const field = enumOf(
			withAddedOptions(actType, [
				added({ option: "impact", label: "Impact play" }),
			]),
		);
		expect(field.options).toEqual(["impact", "oral"]);
		expect(field.option_labels?.impact).toBe("Impact");
	});
});

/**
 * Tokens are machine values — an event stores one, a rule condition matches on
 * one, an export carries one — so a couple-authored token has to read like a
 * pack-authored one, and `toOptionToken` is the single path from typed words to
 * one. Sharing it with the editor is what makes the token previewed the token
 * stored.
 */
describe("toOptionToken", () => {
	it("lowercases and joins words with underscores", () => {
		expect(toOptionToken("Aftercare check")).toBe("aftercare_check");
		expect(toOptionToken("  Rope   play!  ")).toBe("rope_play");
	});

	it("produces a token the schema accepts", () => {
		expect(
			optionTokenSchema.safeParse(toOptionToken("Rope play")).success,
		).toBe(true);
	});

	it("returns empty for input with no word in it", () => {
		expect(toOptionToken("!!!")).toBe("");
		expect(optionTokenSchema.safeParse("").success).toBe(false);
	});
});
