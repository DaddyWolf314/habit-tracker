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
	/**
	 * The partner's (in practice the dom's) warm prose reaction to a journal entry
	 * (ADR 0001). A *gift, not a debt* — never tracked as pending/owed, never
	 * queued. Authored by the *non-author* of the entry, allowed on `shared` and
	 * `sealed` entries (never `secret`); it fires no rule effects and does not touch
	 * composite metadata. Distinct from `note_appended` (the author's own added
	 * context) and `adjudication` (a ruling on an awaited key).
	 */
	z.object({
		kind: z.literal("response"),
		note: z.string(),
		...amendmentBase,
	}),
]);
export type Amendment = z.infer<typeof amendmentSchema>;

/**
 * The payload a client submits to amend an event. The server assigns `id`,
 * `created_at`, and the `actor` (the authenticated member) — a client can no
 * more forge who ruled than it can forge who logged an event. Semantic checks
 * (permitted keys, supersede rules, retraction-while-pending) live in
 * `amendment-validation.ts`; this schema only fixes the shape.
 */
export const amendmentInputSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("adjudication"),
		target_event_id: z.string().min(1),
		patch: z.record(z.string(), metadataValueSchema),
		note: z.string().optional(),
		supersedes: z.string().optional(),
	}),
	z.object({
		kind: z.literal("note_appended"),
		target_event_id: z.string().min(1),
		note: z.string().min(1),
	}),
	z.object({
		kind: z.literal("retracted"),
		target_event_id: z.string().min(1),
		note: z.string().optional(),
	}),
	z.object({
		kind: z.literal("response"),
		target_event_id: z.string().min(1),
		note: z.string().min(1),
	}),
]);
export type AmendmentInput = z.infer<typeof amendmentInputSchema>;
