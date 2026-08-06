import { AGREEMENT_REF_KIND } from "./agreements.ts";
import type { EventType, MetadataField } from "./event-types.ts";
import { REWARD_REF_KIND } from "./rewards.ts";
import type { MetadataValue } from "./roles.ts";

/**
 * The originating side of the ref model (ADR 0005, CONTEXT §Ref) — pure and
 * dependency-free like `ref-candidates.ts`, which owns the echoing side, so the
 * Durable Object mints through the same function the UI hides through.
 *
 * A ref either *originates* an id (this event is where it comes into existence)
 * or *echoes* one minted elsewhere in order to pair with it. `minted: true` says
 * which, and it means exactly one thing: **the server assigns this value at log
 * time and a client may never supply it.** Generation is the uniqueness
 * guarantee — a hand-typed id is a name, and two tasks can share a name, so
 * matching on one lets the wrong countdown be discharged.
 *
 * Two consequences follow from the same flag, and both live here so they cannot
 * disagree: the write side mints ({@link mintOriginatingRefs}) and the read side
 * hides ({@link readableMetadata}). A minted ref is machine identity, not
 * content — a reader learns nothing from `01JB6X…` — so the human label lives in
 * an ordinary `text` field beside it (`task_assigned.task_name`). The export is
 * deliberately not a reader in this sense: it serializes everything, so nothing
 * becomes unauditable.
 */

/** Whether a field is an originating ref: server-minted, never client-supplied. */
export function isOriginatingRef(field: MetadataField): boolean {
	return field.kind === "ref" && field.minted === true;
}

/**
 * Whether the **server** owns this field's value at log time — a minted ref, or
 * anything else declared `server_set` (a redemption's `price`, `currency` and
 * `granted`, ADR 0017).
 *
 * The *write*-side question, and deliberately not the same one
 * {@link readableMetadata} asks. A composer must offer no input for either kind,
 * and must not demand one as required — a `required` field the server supplies
 * would otherwise block the form until the author types a value the server then
 * refuses. But only a minted ref is hidden on the way *out*: a price is content,
 * and the reason it is stamped at all is so a reader can find what a redemption
 * cost.
 */
export function isServerAssigned(field: MetadataField): boolean {
	return isOriginatingRef(field) || field.server_set === true;
}

/**
 * The ref kinds that name a **definition** — the corpus (ADR 0006) and, since
 * ADR 0017, the reward store. A *set* rather than a second equality test, because
 * what makes a ref citing is that the app holds a versioned row for what it
 * names, and that is a growing list: each entry here is one more definition kind
 * whose candidates come from "the ones in force" and whose value resolves at the
 * citing event's `occurred_at`.
 */
export const CITING_REF_KINDS: ReadonlySet<string> = new Set([
	AGREEMENT_REF_KIND,
	REWARD_REF_KIND,
]);

/**
 * Whether a field is a **citing** ref — the third flavor (ADR 0006): it names a
 * definition the app holds a row for, rather than an id some event minted.
 *
 * Derived from the declared `ref_kind` rather than a flag of its own, matching
 * how echoing candidates are derived from the rules: what a ref points at is
 * already stated in the schema, and a second marker could only ever disagree
 * with it. Nothing mints a citing ref, so it is never originating.
 */
export function isCitingRef(field: MetadataField): boolean {
	return citingRefKind(field) !== undefined;
}

/**
 * *Which* definition set a citing ref names, or undefined when the field cites
 * nothing — the accessor every caller that has to branch reads through.
 *
 * One place asks "is this a ref, is it unminted, is its kind a citing one", so a
 * caller picking between the corpus and the store writes a single comparison
 * against a value rather than repeating the three-part test. Before this, both
 * the candidate picker and the log row re-checked `field.kind === "ref"` inside
 * a branch {@link isCitingRef} had already established.
 */
export function citingRefKind(field: MetadataField): string | undefined {
	if (field.kind !== "ref" || field.minted === true) return undefined;
	return field.ref_kind !== undefined && CITING_REF_KINDS.has(field.ref_kind)
		? field.ref_kind
		: undefined;
}

/**
 * The result of minting: the metadata to persist, or the reason the input was
 * rejected. A client-supplied value on a minted field is an error rather than
 * something to overwrite silently — a caller that thinks it owns the id needs to
 * hear that it doesn't.
 */
export type MintOutcome =
	| { ok: true; metadata: Record<string, MetadataValue> }
	| { ok: false; error: string };

/**
 * Assigns every originating ref on `type` a fresh id from `mint`, returning the
 * metadata to store. Called *before* persistence, which is what makes a rebuild
 * replay a stored id verbatim rather than re-minting a new one — history is
 * reproduced, never rewritten. Pre-ADR-0005 events therefore keep whatever ids
 * they were logged with, including hand-typed ones that can still collide with
 * each other; that is intended, and there is no migration.
 */
export function mintOriginatingRefs(
	type: Pick<EventType, "metadata">,
	metadata: Record<string, MetadataValue>,
	mint: () => string,
): MintOutcome {
	const out = { ...metadata };
	for (const [key, field] of Object.entries(type.metadata)) {
		if (!isOriginatingRef(field)) continue;
		if (out[key] !== undefined) {
			return { ok: false, error: `${key} is assigned by the server` };
		}
		out[key] = mint();
	}
	return { ok: true, metadata: out };
}

/**
 * The metadata entries a human-facing surface should show: everything except the
 * originating refs. The composer already hides minted fields on the write side;
 * this is the same rule on the read side, so the two agree. An unknown type
 * hides nothing — better an opaque id than a silently dropped value.
 */
export function readableMetadata(
	type: Pick<EventType, "metadata"> | undefined,
	metadata: Record<string, MetadataValue>,
): [string, MetadataValue][] {
	return Object.entries(metadata).filter(([key]) => {
		const field = type?.metadata[key];
		return !field || !isOriginatingRef(field);
	});
}
