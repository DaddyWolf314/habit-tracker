import { z } from "zod";
import { permissionListSchema, type Role } from "./roles.ts";

/**
 * The Agreement corpus (ADR 0006) — the couple's own terms, as distinct from the
 * engine **Rule** that shares the word. Pure and isomorphic like `rules.ts`, with
 * no storage or runtime dependency, so the Durable Object and the UI reach the
 * same answers through the same functions.
 *
 * Two things live here that nothing else may re-derive:
 *
 *  - **Resolution.** A citing ref reads {@link agreementEffectiveAt} at the citing
 *    event's `occurred_at` — what the person was bound by when they acted. That is
 *    deliberately *not* the rule-version clock, which is log-time (ADR 0002): a
 *    rule version governs when the machine acted, an Agreement version governs
 *    what was agreed. Backfill is normal in this app, so log-time resolution here
 *    would convict someone under terms written after the act.
 *  - **Authorship.** {@link validateAgreementWrite} is the single gate for every
 *    write. The DO calls it and maps the result to a status code; it holds no
 *    authorization logic of its own, so there is one place to read and one place
 *    to test. Shape follows `amendment-validation.ts`, including the `forbidden`
 *    flag that separates a 403 from a 400.
 */

/**
 * One effective-dated revision. Name and prose version *together*, so renaming is
 * never retroactive: a citation renders what the term was called at the time.
 * `retired` is a version like any other — retiring is effective-dated, not a
 * column flip, so a retired Agreement stays readable and still resolves.
 */
export const agreementVersionSchema = z.object({
	effective_from: z.number().int(),
	name: z.string().min(1),
	text: z.string(),
	/**
	 * How often to prompt a review of this term (ADR 0006). A nudge starts a
	 * conversation and **never lapses** the Agreement — an unanswered one leaves it
	 * in force, because a lapse would retire a term neither partner retired.
	 */
	review_cadence_days: z.number().int().positive().optional(),
	retired: z.boolean().default(false),
});
export type AgreementVersion = z.infer<typeof agreementVersionSchema>;

/**
 * A per-couple kind, shaped like an event type: a label plus the roles that may
 * author entries of it. `author_permission` is what makes "the sub alone writes
 * limits" structural, and {@link validateAgreementWrite} guards the layer above it.
 */
export const agreementKindSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	author_permission: permissionListSchema,
});
export type AgreementKind = z.infer<typeof agreementKindSchema>;

/**
 * A stable id carrying append-only versions, ascending by `effective_from`.
 * `kind` sits here rather than on a version and never changes with one: a
 * versioned kind would be an escalation path, since re-kinding is how you would
 * otherwise author in the other role's category.
 */
export const versionedAgreementSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1),
	versions: z.array(agreementVersionSchema).min(1),
});
export type VersionedAgreement = z.infer<typeof versionedAgreementSchema>;

/**
 * The version in force at `atMs` — the latest whose `effective_from` is at or
 * before it. Null before the first version: a citation cannot predate the term,
 * and falling back to the earliest would bind someone to something not yet
 * written. A version dated ahead of `atMs` is the announced draft and governs
 * nothing yet.
 */
export function agreementEffectiveAt(
	agreement: VersionedAgreement,
	atMs: number,
): AgreementVersion | null {
	let winner: AgreementVersion | null = null;
	for (const version of agreement.versions) {
		if (version.effective_from > atMs) continue;
		if (winner === null || version.effective_from >= winner.effective_from) {
			winner = version;
		}
	}
	return winner;
}

/**
 * The Agreements a citing ref may offer at `atMs`: those in force and not
 * retired. The lifecycle is the *opposite* of an echoing ref's candidates — a
 * retired Agreement leaves the picker while every past citation of it still
 * resolves through {@link agreementEffectiveAt} and every rule matching it still
 * fires on replay.
 */
export function agreementsInForce(
	agreements: VersionedAgreement[],
	atMs: number,
): VersionedAgreement[] {
	return agreements.filter((a) => {
		const version = agreementEffectiveAt(a, atMs);
		return version !== null && !version.retired;
	});
}

/** Whether `role` may author entries of `kindId`. An unresolved role authors nothing. */
export function authorsKind(
	kinds: AgreementKind[],
	kindId: string,
	role: Role | null,
): boolean {
	if (role === null) return false;
	const kind = kinds.find((k) => k.id === kindId);
	return kind?.author_permission.includes(role) ?? false;
}

/** Every write the corpus accepts. One shape in, one validation gate. */
export type AgreementWrite =
	| { op: "create"; kind: string; name: string; text: string }
	| { op: "revise"; id: string; name: string; text: string }
	| { op: "recategorize"; id: string; kind: string }
	| { op: "retire"; id: string }
	| { op: "delete"; id: string }
	| { op: "edit_kind"; id: string; author_permission: Role[] };

export interface AgreementContext {
	/** The actor's resolved role; null before mutual confirmation. */
	role: Role | null;
	kinds: AgreementKind[];
	agreements: VersionedAgreement[];
	/** Ids any event has ever cited — the gate on hard delete. */
	cited: Set<string>;
}

export type AgreementValidation =
	| { ok: true }
	/** `forbidden` marks an authorization refusal (a 403) vs a malformed one (a 400). */
	| { ok: false; error: string; forbidden?: boolean };

const deny = (error: string, forbidden = false): AgreementValidation => ({
	ok: false,
	error,
	forbidden,
});

/**
 * Validates a proposed write. First failure wins.
 *
 * The escalation invariant is the reason this is one function rather than a
 * check at each call site: **you can never grant yourself authorship you do not
 * already hold.** Editing a kind's author list requires already being in it, and
 * moving an entry between kinds requires authoring *both* — so neither the layer
 * above a limit nor a sideways move into it opens a path the direct edit closes.
 */
export function validateAgreementWrite(
	write: AgreementWrite,
	ctx: AgreementContext,
): AgreementValidation {
	if (write.op === "edit_kind") {
		const kind = ctx.kinds.find((k) => k.id === write.id);
		if (!kind) return deny("no such kind");
		// The invariant, from the kind side. Without this the dom adds themselves
		// to `limit` and every guard below becomes decoration.
		if (!authorsKind(ctx.kinds, write.id, ctx.role)) {
			return deny(
				"only an author of this kind may change who authors it",
				true,
			);
		}
		return { ok: true };
	}

	if (write.op === "create") {
		if (!ctx.kinds.some((k) => k.id === write.kind))
			return deny("no such kind");
		if (!authorsKind(ctx.kinds, write.kind, ctx.role)) {
			return deny("your role doesn't author this kind of agreement", true);
		}
		return { ok: true };
	}

	const agreement = ctx.agreements.find((a) => a.id === write.id);
	if (!agreement) return deny("no such agreement");
	// Every remaining op edits an existing entry, so all of them need authorship
	// of the kind it currently sits in.
	if (!authorsKind(ctx.kinds, agreement.kind, ctx.role)) {
		return deny("your role doesn't author this kind of agreement", true);
	}

	switch (write.op) {
		case "recategorize":
			if (!ctx.kinds.some((k) => k.id === write.kind))
				return deny("no such kind");
			// The invariant, from the entry side: authoring the source is not enough,
			// or a dom could walk a protocol they own into the sub's category.
			if (!authorsKind(ctx.kinds, write.kind, ctx.role)) {
				return deny(
					"your role doesn't author the kind you're moving it to",
					true,
				);
			}
			return { ok: true };
		case "delete":
			// ADR 0002's "delete collapses to disable", applied to terms: retiring
			// keeps every version readable, so something a member was held to can
			// never leave the record. Only a never-cited entry is truly deletable.
			if (ctx.cited.has(write.id)) {
				return deny(
					"an agreement something has cited can be retired, not deleted",
				);
			}
			return { ok: true };
		case "revise":
		case "retire":
			return { ok: true };
	}
}
