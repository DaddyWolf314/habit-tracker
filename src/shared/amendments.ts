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

/**
 * One effect a waiver overrules, named by the rule that produced it and the
 * effect's position in that rule's `effects` list (ADR 0016).
 *
 * A position rather than a description of the effect, because the trace row has
 * to name *what* was waived and a rebuild has to reproduce the same choice: the
 * pair `(rule_id, effect_index)` is stable across a replay in a way a phrase
 * ("+2 demerits") is not, and it stays meaningful when a rule moves more than one
 * counter. What it deliberately does *not* do is re-derive the effect from the
 * rule definition on read — a definition may have been edited since (ADR 0002),
 * so the effect that is reversed is always read back from the trace.
 */
export const waivedEffectSchema = z.object({
	rule_id: z.string().min(1),
	effect_index: z.number().int().min(0),
});
export type WaivedEffect = z.infer<typeof waivedEffectSchema>;

/** The `rule#index` key a waived-effect set is looked up by. */
export function waivedEffectKey(effect: WaivedEffect): string {
	return `${effect.rule_id}#${effect.effect_index}`;
}

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
	/**
	 * The dom overruling a rule's *output* while leaving the fact it matched on
	 * standing (ADR 0016). Mercy, not correction — the rule fired correctly and is
	 * being let go — which is why it is an amendment (a post-hoc record against an
	 * event) rather than a direct counter adjustment: the latter would file a
	 * relationship act under the `+1` sugar and leave the trace saying "dom
	 * adjusted demerits −1" without ever saying why.
	 *
	 * One kind, two mechanics, chosen by whether the effect has landed:
	 *  - `suppresses` set — waived on the confirm sheet, alongside the ruling whose
	 *    id it carries. The effect is *never applied*; there is no compensating
	 *    move, because a counter's history must carry no peak that never existed.
	 *  - `suppresses` absent — waived after the effect landed (R2 fires at append,
	 *    where there is no sheet to uncheck), so each named effect is **reversed**
	 *    where its inverse still commutes and files a `reversal_declined` trace row
	 *    where it does not.
	 *
	 * It touches no composite metadata: a waiver says nothing about whether the
	 * fact was true, only about what follows from it.
	 */
	z.object({
		kind: z.literal("waiver"),
		waived: z.array(waivedEffectSchema).min(1),
		/** The adjudication whose effects this suppressed before they landed. */
		suppresses: z.string().optional(),
		note: z.string().optional(),
		...amendmentBase,
	}),
]);
export type Amendment = z.infer<typeof amendmentSchema>;

/** A waiver, narrowed — the arm the suppression and reversal paths pass around. */
export type Waiver = Extract<Amendment, { kind: "waiver" }>;

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
		/**
		 * Effects the dom unchecked on the confirm sheet (ADR 0016). Submitted with
		 * the ruling rather than after it because suppression has to happen *before*
		 * the effect lands: the server splits this into a companion `waiver`
		 * amendment naming this ruling, and the re-evaluation skips exactly these.
		 */
		waive: z.array(waivedEffectSchema).optional(),
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
	/**
	 * A standalone waiver over effects that have already landed — the entry point
	 * from a log row, for the unconditional rules that fire at append with no
	 * ruling in play. `suppresses` is absent by construction: a client cannot
	 * suppress after the fact, and the server assigns it on the confirm-sheet path.
	 */
	z.object({
		kind: z.literal("waiver"),
		target_event_id: z.string().min(1),
		waived: z.array(waivedEffectSchema).min(1),
		note: z.string().optional(),
	}),
]);
export type AmendmentInput = z.infer<typeof amendmentInputSchema>;
