import { z } from "zod";
import { permissionListSchema, valenceSchema } from "./roles.ts";

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
	z.object({
		kind: z.literal("ref"),
		// e.g. "ritual" | "task" | "rule" — what the ref points at.
		ref_kind: z.string().optional(),
		...metadataFieldBase,
	}),
]);
export type MetadataField = z.infer<typeof metadataFieldSchema>;

export const eventTypeSchema = z.object({
	id: z.string(),
	label: z.string(),
	icon: z.string().optional(),
	valence: valenceSchema.default("neutral"),
	log_permission: permissionListSchema,
	subject_required: z.boolean().default(false),
	metadata: z.record(z.string(), metadataFieldSchema).default({}),
	/**
	 * Metadata keys whose absence in composite state makes an event *pending*.
	 * This single property is the adjudication-queue mechanism (handoff §5).
	 */
	awaiting: z.array(z.string()).default([]),
	note_prompt: z.string().optional(),
});
export type EventType = z.infer<typeof eventTypeSchema>;
