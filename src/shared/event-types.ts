import { z } from "zod";
import {
	type MetadataValue,
	permissionListSchema,
	type Role,
	roleSchema,
	valenceSchema,
} from "./roles.ts";

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
};

export const metadataFieldSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("boolean"), ...metadataFieldBase }),
	z.object({
		kind: z.literal("enum"),
		options: z.array(z.string()).min(1),
		...metadataFieldBase,
	}),
	z.object({
		kind: z.literal("number"),
		min: z.number().optional(),
		max: z.number().optional(),
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
		// e.g. "ritual" | "task" | "rule" — what the ref points at.
		ref_kind: z.string().optional(),
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
