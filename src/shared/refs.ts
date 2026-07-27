import { AGREEMENT_REF_KIND } from "./agreements.ts";
import type { EventType, MetadataField } from "./event-types.ts";
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
 * Whether a field is a **citing** ref — the third flavor (ADR 0006): it names a
 * definition the app holds a row for, rather than an id some event minted.
 *
 * Derived from the declared `ref_kind` rather than a flag of its own, matching
 * how echoing candidates are derived from the rules: what a ref points at is
 * already stated in the schema, and a second marker could only ever disagree
 * with it. Nothing mints a citing ref, so it is never originating.
 */
export function isCitingRef(field: MetadataField): boolean {
	return (
		field.kind === "ref" &&
		field.minted !== true &&
		field.ref_kind === AGREEMENT_REF_KIND
	);
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
