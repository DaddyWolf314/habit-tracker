import { z } from "zod";
import {
	type MetadataValue,
	permissionListSchema,
	type Role,
	roleSchema,
	valenceSchema,
} from "./roles.ts";
import { humanize } from "./trace.ts";

/**
 * Event-type schema format (handoff §5). Stored per-couple in the DO; the
 * starter seven ship as defaults and custom types are identical in shape.
 *
 * Each metadata field carries two permissions:
 *  - `set_permission`   — who may set the key at logging time.
 *  - `adjudicated_by`   — who may rule on the key afterward, via an amendment.
 */
const metadataFieldBase = {
	label: z.string(),
	required: z.boolean().default(false),
	set_permission: permissionListSchema,
	adjudicated_by: permissionListSchema.optional(),
	/**
	 * The server assigns this key's value at log time and a client may never
	 * supply it — ADR 0005's minting discipline, on a field that is not a minted
	 * **Ref** (a redemption's `price`, `currency` and `granted`, ADR 0017).
	 *
	 * Deliberately a second flag rather than widening `minted`, because the two
	 * drive *different sides*. `minted` says the value is machine identity, so it
	 * is hidden from readers as well as writers — nobody learns anything from
	 * `01JB6X…`. A stamped price is the opposite: it is **content**, and the one
	 * thing a reader most wants off a redemption. So this hides the field from the
	 * *composer* and exempts it from the required check, while leaving it visible
	 * everywhere it is read.
	 *
	 * Declared on the base rather than one arm because what is stamped is not one
	 * kind: a price is a `number`, a currency a `ref`, a grant a `boolean`.
	 */
	server_set: z.boolean().optional(),
};

export const metadataFieldSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("boolean"), ...metadataFieldBase }),
	z.object({
		kind: z.literal("enum"),
		options: z.array(z.string()).min(1),
		/**
		 * Display copy per option, keyed by stored value (#155). The stored value is
		 * a machine token; this is the word a person reads, so every generic enum
		 * control renders through {@link optionLabel} rather than printing the token
		 * — the same rule CONTEXT.md's **Disposition** entry states for closed
		 * timers, applied to the one control that had been exempt from it.
		 *
		 * Optional and partial on purpose. A couple's own event type carries no copy
		 * and must still render, so an unlabelled option de-slugs rather than
		 * failing; the pack labels every option of every enum it ships (pinned by a
		 * test in `rules.pack.test.ts`).
		 *
		 * The copy here is **speaker-neutral**, because one field is read by both
		 * partners in different voices — the sub claiming how they did and the dom
		 * ruling on it. A surface whose voice differs enough to need its own words
		 * overrides locally (`countdowns-panel.tsx`'s `QUALITY_LABELS`); this is the
		 * copy for every surface that doesn't.
		 */
		option_labels: z.record(z.string(), z.string()).optional(),
		...metadataFieldBase,
	}),
	z.object({
		kind: z.literal("number"),
		min: z.number().optional(),
		max: z.number().optional(),
		/**
		 * Declares the field whole (ADR 0015). Until `by_from` existed, a number
		 * field's range was all a rule could care about; a routed *magnitude* also
		 * cares whether the number divides. `increment_counter.by` is
		 * `z.number().int()` and its comment gives the reason — a fractional `by`
		 * drives the counter cache non-integer and breaks reads and export — so
		 * without this flag `by_from` could route `2.5` into an integer counter and
		 * nothing could see it coming.
		 *
		 * {@link validateRule} refuses a `by_from` naming a field that does not carry
		 * it, which puts the failure at authoring time, where this repo has
		 * consistently put routing failures. Optional, because it constrains only the
		 * one routing that needs it: a field is not wrong for being fractional, it is
		 * merely not a magnitude.
		 */
		integer: z.boolean().optional(),
		...metadataFieldBase,
	}),
	/**
	 * A short human label the author types (`task_assigned`'s `task_name`,
	 * ADR 0005) — display data a rule may route as a timer's `tag`, never an
	 * identity to match on. Freeform prose stays in `note`, which is why this
	 * carries a `max_length`: a text field is a name, not a paragraph.
	 */
	z.object({
		kind: z.literal("text"),
		max_length: z.number().int().positive().optional(),
		...metadataFieldBase,
	}),
	z.object({
		kind: z.literal("ref"),
		// e.g. "task" | "session" | "agreement" — what the ref points at.
		ref_kind: z.string().optional(),
		/**
		 * Narrows a **citing** ref to one Agreement kind (ADR 0006). Without it a
		 * citing field offers the whole corpus, which is right for an `infraction`
		 * — any term can be broken — and wrong for `ritual_completed`, which should
		 * offer rituals rather than the couple's limits and safewords.
		 */
		agreement_kind: z.string().optional(),
		/**
		 * A minted ref is *assigned by the server* at log time (a fresh ULID), never
		 * supplied by the client — the event carrying it is the origin of the ref,
		 * and generation is what guarantees uniqueness (#102). Non-minted refs echo
		 * an id minted elsewhere (`journal_entry.prompt_id`, `session_id` on
		 * `session_ended`).
		 */
		minted: z.boolean().optional(),
		...metadataFieldBase,
	}),
]);
export type MetadataField = z.infer<typeof metadataFieldSchema>;

/**
 * How one metadata option reads to a person (#155) — the single phrasing path
 * every enum control and readout shares, so a value the sub picks and the value
 * the dom rules on can never be different words.
 *
 * Three rungs, most specific first: the pack's (or the couple's) declared
 * `option_labels` copy, then a de-slug, then the token itself. The de-slug rung
 * is what makes this safe to apply to *any* enum — a custom field a couple
 * authored with no copy at all still reads as words rather than
 * `wants_conversation`.
 *
 * Takes the whole field rather than the label map so callers that fold booleans
 * into the same control (`yes`/`no` rendered as options) can route every option
 * through one function. A boolean carries no copy, so its options fall through
 * to the de-slug and read exactly as they did.
 */
export function optionLabel(field: MetadataField, option: string): string {
	if (field.kind === "enum") {
		const label = field.option_labels?.[option];
		if (label) return label;
	}
	return humanize(option);
}

/**
 * What an option token may look like (#185). Tokens are machine values: they are
 * what an event stores, what a rule condition matches on, and what an export
 * carries, so a couple-authored one has to read like a pack-authored one. Lower
 * snake case keeps {@link optionLabel}'s de-slug rung honest — an option whose
 * label is later cleared still reads as words.
 */
export const optionTokenSchema = z
	.string()
	.regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, "use lowercase words, e.g. after_care")
	.max(40);

/**
 * The token for a word a person typed — "After care" → `after_care`. Shared
 * rather than duplicated in the editor, so the token the UI previews is the
 * token the server stores and validates. Returns "" for input with nothing
 * token-worthy in it, which the caller rejects as an empty word.
 */
export function toOptionToken(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function extendEnum(
	field: Extract<MetadataField, { kind: "enum" }>,
	additions: readonly OptionAddition[],
): MetadataField {
	const options = [...field.options];
	const labels = { ...field.option_labels };
	for (const { option, label } of additions) {
		// The pack has since shipped this option itself. It is the pack's now: keep
		// its position and its copy, so a bump that relabels it wins over a label
		// the couple typed before it existed. The overlay row is left alone, so the
		// word survives if a later bump drops it again.
		if (field.options.includes(option)) continue;
		options.push(option);
		if (label) labels[option] = label;
	}
	return Object.keys(labels).length > 0
		? { ...field, options, option_labels: labels }
		: { ...field, options };
}

/**
 * One `awaiting` entry (handoff §5, ADR 0003). A bare key gates pending status
 * regardless of subject — today's meaning, unchanged. A qualified entry gates
 * only when the event's subject resolves to the named role: the starter
 * `orgasm`'s `permitted` is awaited only for a sub-subject event, so a
 * dom-subject orgasm is never pending — nobody adjudicates the authority.
 */
export const awaitingEntrySchema = z.union([
	z.string(),
	z.object({ key: z.string(), subject_role: roleSchema }),
]);
export type AwaitingEntry = z.infer<typeof awaitingEntrySchema>;

/**
 * The awaited keys *in force* for an event whose subject resolves to
 * `subjectRole` (via `resolveSubjectRole` — the same seam rule conditions use).
 * Every consumer of `awaiting` — pending derivation, the queue, the engine's
 * near-miss filter, the composer's "leave blank to defer" hint — reads through
 * this, so a qualified entry can never gate one surface and not another.
 */
export function awaitingKeysFor(
	awaiting: AwaitingEntry[],
	subjectRole: Role | undefined,
): string[] {
	return awaiting.flatMap((entry) =>
		typeof entry === "string"
			? [entry]
			: entry.subject_role === subjectRole
				? [entry.key]
				: [],
	);
}

export const eventTypeSchema = z.object({
	id: z.string(),
	label: z.string(),
	icon: z.string().optional(),
	valence: valenceSchema.default("neutral"),
	log_permission: permissionListSchema,
	subject_required: z.boolean().default(false),
	metadata: z.record(z.string(), metadataFieldSchema).default({}),
	/**
	 * Entries whose keys' absence in composite state makes an event *pending*.
	 * This single property is the adjudication-queue mechanism (handoff §5).
	 * An entry may be subject-role-qualified (ADR 0003) — see
	 * {@link awaitingEntrySchema}; read via {@link awaitingKeysFor}, never
	 * directly.
	 */
	awaiting: z.array(awaitingEntrySchema).default([]),
	note_prompt: z.string().optional(),
	/**
	 * Journaling capability (ADR 0001). Only a journaling-capable type may carry a
	 * non-`shared` visibility and may be the answer paired to a `journal_prompt`.
	 * Accountability types (`infraction`, `orgasm`, `task_completed`, …) and the
	 * plain `note` leave this `false` and are therefore always `shared` — a secret
	 * infraction would gut the consent-record spine. The visibility gate itself is
	 * `visibilityAllowedForType` in `visibility.ts`.
	 */
	journaling: z.boolean().default(false),
});
export type EventType = z.infer<typeof eventTypeSchema>;

/**
 * One option a couple added to a pack enum (#185, ADR 0014).
 *
 * This is an **overlay**, not a fork. Adopt-on-edit (ADR 0002) is right for a
 * rule, which is one atomic statement, and wrong for an event type, which is a
 * composite — a couple who added one act would freeze `detail`, `awaiting`,
 * `option_labels` and the permissions along with it, paying for one word with
 * every future pack improvement to the type. An added option is a delta in a way
 * that an edited rule condition is not, so it rides alongside the pack
 * definition instead of replacing it.
 */
export const optionAdditionSchema = z.object({
	type_id: z.string(),
	field_key: z.string(),
	option: optionTokenSchema,
	label: z.string().trim().min(1).max(60).optional(),
});
export type OptionAddition = z.infer<typeof optionAdditionSchema>;

/**
 * A pack type with the couple's added options folded in — the merge the whole of
 * #185 rests on.
 *
 * It runs at the DO's *type read seam* (`eventTypeById` / `listEventTypes`),
 * never at a call site, because two validators test enum membership and would
 * otherwise refuse a couple's own word outright: {@link checkMetadataValue} on
 * both write paths, and `rule-validation.ts` at rule creation. Merging once at
 * the read means log validation, rule validation, the composer, the queue, the
 * engine and {@link optionLabel} all see the same set with no per-caller
 * awareness — and a couple-added option is indistinguishable from a pack one
 * everywhere downstream, which is the point.
 *
 * Additions for other types are ignored, so a caller may pass the whole overlay.
 */
export function withAddedOptions(
	type: EventType,
	additions: readonly OptionAddition[],
): EventType {
	const byField = new Map<string, OptionAddition[]>();
	for (const addition of additions) {
		if (addition.type_id !== type.id) continue;
		const forField = byField.get(addition.field_key);
		if (forField) forField.push(addition);
		else byField.set(addition.field_key, [addition]);
	}
	if (byField.size === 0) return type;

	const metadata: Record<string, MetadataField> = {};
	for (const [key, field] of Object.entries(type.metadata)) {
		const added = byField.get(key);
		// An overlay outlives the definition it rides on. A pack bump may drop the
		// field or change its kind, and an addition to something that is no longer
		// an enum is inert rather than fatal — the same graceful-degradation call
		// `optionLabel`'s de-slug rung makes, and the reason `seedDefaults` can keep
		// blindly upserting.
		metadata[key] =
			added && field.kind === "enum" ? extendEnum(field, added) : field;
	}
	return { ...type, metadata };
}

/**
 * Ensures a metadata value fits its field's kind. Returns null when it does, or
 * the reason it doesn't, keyed by the field name.
 *
 * The one check both write paths run: the DO's log-time validation and the
 * amendment path's patch validation. They were the same switch written twice,
 * which is exactly how a kind ends up accepted at logging and rejected by a
 * ruling (or worse, the reverse) — a value that could never be logged must not
 * be able to arrive by amendment either.
 */
export function checkMetadataValue(
	key: string,
	field: MetadataField,
	value: MetadataValue,
): string | null {
	switch (field.kind) {
		case "boolean":
			return typeof value === "boolean" ? null : `${key} must be a boolean`;
		case "number":
			if (typeof value !== "number") return `${key} must be a number`;
			if (field.min !== undefined && value < field.min)
				return `${key} below minimum`;
			if (field.max !== undefined && value > field.max)
				return `${key} above maximum`;
			return null;
		case "enum":
			return typeof value === "string" && field.options.includes(value)
				? null
				: `${key} is not an allowed option`;
		case "text":
			if (typeof value !== "string") return `${key} must be text`;
			if (field.max_length !== undefined && value.length > field.max_length)
				return `${key} is too long`;
			return null;
		case "ref":
			return typeof value === "string" ? null : `${key} must be a reference`;
	}
}
