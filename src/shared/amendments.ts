import { z } from "zod";
import { metadataValueSchema } from "./roles.ts";

/**
 * Amendments (handoff §4.2). Events are never mutated or deleted; every
 * post-hoc change is one of these records. Composite event state is the
 * original metadata overlaid by amendments in timestamp order (latest
 * non-superseded wins per key) — derived, never stored.
 */
const amendmentBase = {
	id: z.string(), // ULID
	target_event_id: z.string(),
	actor: z.string(),
	created_at: z.number().int(),
};

export const amendmentSchema = z.discriminatedUnion("kind", [
	/**
	 * A ruling on awaited keys. `patch` may only touch keys the actor's role is
	 * `adjudicated_by` for. `supersedes` corrects a prior ruling — corrections
	 * supersede, never delete. One active ruling per key.
	 */
	z.object({
		kind: z.literal("adjudication"),
		patch: z.record(z.string(), metadataValueSchema),
		note: z.string().optional(),
		supersedes: z.string().optional(),
		...amendmentBase,
	}),
	/** Sub adds context to their own pending event; no rule effects. */
	z.object({
		kind: z.literal("note_appended"),
		note: z.string(),
		...amendmentBase,
	}),
	/**
	 * Sub-authored, allowed only while the event is pending; removes it from the
	 * queue and marks it in the log. There is no deletion.
	 */
	z.object({
		kind: z.literal("retracted"),
		note: z.string().optional(),
		...amendmentBase,
	}),
]);
export type Amendment = z.infer<typeof amendmentSchema>;
