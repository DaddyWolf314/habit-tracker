import { z } from "zod";
import { versionInForceAt } from "./effective-dating.ts";
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
 * author entries of it. `author_permission` is what makes "the dom does not write
 * the sub's limits" structural, and {@link validateAgreementWrite} guards the
 * layer above it.
 *
 * A `switch` authors both sides, sub-side kinds included: they hold both halves
 * of the dynamic, and a `sub`-only limit kind would leave a switch/switch couple
 * unable to record a boundary at all. Known consequence, stated here because it
 * is easier to meet as a decision than to discover: authorship is **by role, not
 * by member**, so in a `switch`+`sub` couple the switch — the dom-side partner
 * there — can edit that sub's limits. Closing that means scoping a limit to the
 * member it protects rather than to a role, which is a model change, not a
 * permission tweak.
 */
export const agreementKindSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	author_permission: permissionListSchema,
	/**
	 * Whether the couple has edited this kind's author list (#159). Adoption
	 * freezes the list against the pack, exactly as it does a rule's definition
	 * (ADR 0002): a kinds bump stops overwriting it and only raises a notice.
	 *
	 * Absent on the pack's own definitions, which carry no couple state — the
	 * shipped JSON parses through this schema too.
	 */
	adopted: z.boolean().optional(),
	/** Whether the shipped author list now differs from the couple's edited one (#159). */
	upstream_changed: z.boolean().optional(),
});
export type AgreementKind = z.infer<typeof agreementKindSchema>;

/**
 * Adopt-on-edit reconciliation for the kinds pack (#159), the counterpart of
 * `rule-reconciliation.ts` for the corpus. Pure: no storage, no clock, so the
 * decision is testable without a DO.
 *
 * Before this existed, `seedAgreementKinds` upserted `author_permission`
 * unconditionally, so a couple who tightened a kind by hand had it silently
 * reset by the next ship — a permission regression delivered as an upgrade, on
 * the one setting whose whole job is safety. ADR 0010 makes it a precondition:
 * an immutable `author_scope` cannot land on a table the pack rewrites wholesale,
 * or the invariant it rests on is decoration.
 *
 * The three outcomes mirror {@link reconcilePack}:
 *  - **added** — a pack kind the couple does not have yet, installed whole.
 *  - **upserted** — an un-adopted kind whose shipped author list moved; the
 *    couple is still tracking the pack, so it moves with it.
 *  - **skipped** — an adopted kind, frozen. `changedUpstream` says the shipped
 *    list now differs from theirs, which raises the notice rather than applying.
 *
 * **`label` is carried in every bucket, including `skipped`.** A kind's label has
 * no editing surface — `edit_kind` accepts only `author_permission` — so it is
 * pack-owned in the same sense a starter event type's definition is, and an
 * upsert of it can never clobber a couple's customization. Freezing the whole row
 * on adoption would instead strand a corrected label forever on exactly the
 * couples who cared enough to edit the permission beside it.
 *
 * Kinds the pack does not ship are ignored entirely, so a couple's own kind is
 * never touched — the same way `reconcilePack` ignores custom rules.
 */
export interface AgreementKindReconciliation {
	/** Pack kinds absent from the couple; install whole. */
	added: AgreementKind[];
	/** Un-adopted kinds whose author list moved upstream; write label + list. */
	upserted: AgreementKind[];
	/** Adopted kinds left frozen; write the label only, and flag the diff. */
	skipped: Array<{ id: string; label: string; changedUpstream: boolean }>;
}

export function reconcileAgreementKinds(
	pack: readonly AgreementKind[],
	installed: readonly AgreementKind[],
): AgreementKindReconciliation {
	const byId = new Map(installed.map((kind) => [kind.id, kind]));
	const reconciliation: AgreementKindReconciliation = {
		added: [],
		upserted: [],
		skipped: [],
	};

	for (const packKind of pack) {
		const current = byId.get(packKind.id);
		if (!current) {
			reconciliation.added.push(packKind);
			continue;
		}

		const changedUpstream = !sameAuthorship(packKind, current);
		if (current.adopted) {
			reconciliation.skipped.push({
				id: packKind.id,
				label: packKind.label,
				changedUpstream,
			});
		} else if (changedUpstream || packKind.label !== current.label) {
			reconciliation.upserted.push(packKind);
		}
	}
	return reconciliation;
}

/**
 * Whether two kinds permit the same authors. Compared as a **set**, so a
 * reordered role list is not an upstream change — the pack reordering
 * `["sub", "switch"]` must not raise a notice claiming the default moved, for the
 * same reason `sameDefinition` ignores a rule's name: a notice the couple learns
 * to dismiss is worse than no notice.
 *
 * `label` is deliberately not compared. It is pack-owned and always written
 * (see {@link reconcileAgreementKinds}), so a relabel is applied rather than
 * announced.
 */
function sameAuthorship(a: AgreementKind, b: AgreementKind): boolean {
	const roles = (kind: AgreementKind) =>
		[...new Set(kind.author_permission)].sort().join(",");
	return roles(a) === roles(b);
}

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
	return versionInForceAt(agreement.versions, atMs) ?? null;
}

/**
 * The last version written, by `effective_from` — which is not the same as the
 * one in force: an announced draft dated ahead is the latest while governing
 * nothing yet. Retiring reads this rather than {@link agreementEffectiveAt},
 * because a retirement has to land after *every* existing version or a pending
 * draft would later resolve past it and quietly un-retire the term.
 */
export function latestAgreementVersion(
	agreement: VersionedAgreement,
): AgreementVersion {
	let latest = agreement.versions[0];
	for (const version of agreement.versions) {
		if (version.effective_from >= latest.effective_from) latest = version;
	}
	return latest;
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

/**
 * The metadata keys on a type that cite an Agreement — every `ref` field
 * declaring `ref_kind: "agreement"`.
 *
 * Derived from the schema rather than a hardcoded key list, for the same reason
 * ref candidates are derived from the rules: a field declaring the ref kind *is*
 * the statement "this key names an Agreement", so a custom type citing the
 * corpus is covered the day someone writes it. Returns nothing until the pack
 * change lands, which is correct rather than a stub — nothing can cite a corpus
 * that nothing points at.
 */
export function agreementRefKeys(type: {
	metadata: Record<string, { kind: string; ref_kind?: string }>;
}): string[] {
	return Object.entries(type.metadata)
		.filter(([, f]) => f.kind === "ref" && f.ref_kind === AGREEMENT_REF_KIND)
		.map(([key]) => key);
}

/** The `ref_kind` a citing ref declares to point at the corpus. */
export const AGREEMENT_REF_KIND = "agreement";

/**
 * How a citation reads: the term's name **as it stood when the act happened**,
 * and the current one beside it when they differ.
 *
 * Both halves are load-bearing. Rendering today's name would quietly rewrite
 * what the person agreed to — the same retroactivity the `occurred_at` clock
 * exists to prevent, moved from resolution into display. Rendering only the old
 * one would leave a reader unable to find the term in the corpus after a rename.
 *
 * Returns null when the id names nothing the couple holds — a free-text citation
 * logged before the pack change, or a hard-deleted term. The caller shows the
 * raw value then, because an opaque id is a better answer than a blank.
 */
export function describeCitation(
	agreements: VersionedAgreement[],
	id: string,
	occurredAt: number,
	now: number,
): string | null {
	const agreement = agreements.find((a) => a.id === id);
	if (!agreement) return null;
	const then = agreementEffectiveAt(agreement, occurredAt);
	const current =
		agreementEffectiveAt(agreement, now) ?? latestAgreementVersion(agreement);
	// A citation can predate the term's first version only if someone backdated
	// the event; fall back to the earliest wording rather than showing nothing.
	const thenName = then?.name ?? latestAgreementVersion(agreement).name;
	return thenName === current.name
		? thenName
		: `${thenName} (now: ${current.name})`;
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

/**
 * The authoring payloads, shared so the route parses exactly what the DO stores.
 * `effective_from` is optional and defaults to now at the write site; supplying a
 * future one is how a change is *announced* rather than sprung — ADR 0006 has no
 * draft state precisely because a future-dated version is a better one.
 */
export const createAgreementInputSchema = z.object({
	kind: z.string().min(1),
	name: z.string().min(1),
	text: z.string(),
	effective_from: z.number().int().optional(),
	review_cadence_days: z.number().int().positive().optional(),
});
export type CreateAgreementInput = z.infer<typeof createAgreementInputSchema>;

export const reviseAgreementInputSchema = createAgreementInputSchema.omit({
	kind: true,
});
export type ReviseAgreementInput = z.infer<typeof reviseAgreementInputSchema>;

/** Every write the corpus accepts. One shape in, one validation gate. */
export type AgreementWrite =
	| {
			op: "create";
			kind: string;
			name: string;
			text: string;
			effective_from?: number;
	  }
	| {
			op: "revise";
			id: string;
			name: string;
			text: string;
			effective_from?: number;
	  }
	| { op: "rekind"; id: string; kind: string }
	| { op: "retire"; id: string }
	| { op: "delete"; id: string }
	| { op: "edit_kind"; id: string; author_permission: Role[] };

export interface AgreementContext {
	/** The actor's resolved role; null before mutual confirmation. */
	role: Role | null;
	/** Now, so a version cannot be dated into the past. */
	now: number;
	kinds: AgreementKind[];
	agreements: VersionedAgreement[];
	/** Ids any event has ever cited — the gate on hard delete. */
	cited: Set<string>;
}

export type AgreementValidation =
	| { ok: true }
	/**
	 * The flags are the discriminant the caller maps to a status, so no one has to
	 * read the message text to tell an authorization refusal from a missing row
	 * from a malformed request: `forbidden` is a 403, `not_found` a 404, neither a
	 * 400. Matching on prose would make a reworded message silently change a
	 * status code, with nothing to catch it.
	 */
	| {
			ok: false;
			error: string;
			forbidden?: boolean;
			not_found?: boolean;
	  };

const deny = (
	error: string,
	flags: { forbidden?: boolean; not_found?: boolean } = {},
): AgreementValidation => ({ ok: false, error, ...flags });

/**
 * Validates a proposed write. First failure wins.
 *
 * The escalation invariant is the reason this is one function rather than a
 * check at each call site: **you can never grant yourself authorship you do not
 * already hold.** Editing a kind's author list requires already being in it, and
 * moving an entry between kinds requires authoring *both* — so neither the layer
 * above a limit nor a sideways move into it opens a path the direct edit closes.
 */
/**
 * Whether a proposed `effective_from` is legal for a new version, and why not.
 *
 * Forward-only is the guarantee the whole corpus rests on: "editing never
 * disturbs a resolved past citation" (ADR 0006). A version dated into the past
 * would do exactly that — an infraction about an act last week would silently
 * start resolving against text written today, which is the defect this model
 * exists to prevent, reached from the other direction.
 *
 * Dating a version *ahead* is fine and is the point: that is the announced
 * draft, visible to both and governing nothing yet. It must still land after
 * every existing version, or a pending draft would resolve past it.
 */
function checkEffectiveFrom(
	proposed: number | undefined,
	existing: AgreementVersion[],
	now: number,
): AgreementValidation {
	if (proposed === undefined) return { ok: true };
	if (proposed < now) {
		return deny("an agreement can't be backdated — it takes force from now on");
	}
	for (const version of existing) {
		if (proposed <= version.effective_from) {
			return deny("a version already takes force at or after that moment");
		}
	}
	return { ok: true };
}

export function validateAgreementWrite(
	write: AgreementWrite,
	ctx: AgreementContext,
): AgreementValidation {
	if (write.op === "edit_kind") {
		const kind = ctx.kinds.find((k) => k.id === write.id);
		if (!kind) return deny("no such kind", { not_found: true });
		// The invariant, from the kind side. Without this the dom adds themselves
		// to `limit` and every guard below becomes decoration.
		if (!authorsKind(ctx.kinds, write.id, ctx.role)) {
			return deny("only an author of this kind may change who authors it", {
				forbidden: true,
			});
		}
		return { ok: true };
	}

	if (write.op === "create") {
		if (!ctx.kinds.some((k) => k.id === write.kind))
			return deny("no such kind", { not_found: true });
		if (!authorsKind(ctx.kinds, write.kind, ctx.role)) {
			return deny("your role doesn't author this kind of agreement", {
				forbidden: true,
			});
		}
		return checkEffectiveFrom(write.effective_from, [], ctx.now);
	}

	const agreement = ctx.agreements.find((a) => a.id === write.id);
	if (!agreement) return deny("no such agreement", { not_found: true });
	// Every remaining op edits an existing entry, so all of them need authorship
	// of the kind it currently sits in.
	if (!authorsKind(ctx.kinds, agreement.kind, ctx.role)) {
		return deny("your role doesn't author this kind of agreement", {
			forbidden: true,
		});
	}

	switch (write.op) {
		case "rekind":
			if (!ctx.kinds.some((k) => k.id === write.kind))
				return deny("no such kind", { not_found: true });
			// The invariant, from the entry side: authoring the source is not enough,
			// or a dom could walk a protocol they own into the sub's category.
			if (!authorsKind(ctx.kinds, write.kind, ctx.role)) {
				return deny("your role doesn't author the kind you're moving it to", {
					forbidden: true,
				});
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
			return checkEffectiveFrom(
				write.effective_from,
				agreement.versions,
				ctx.now,
			);
		case "retire":
			return { ok: true };
	}
}

/**
 * The `consent_history` entry kind for each write (ADR 0006). Defined here, next
 * to the ops themselves, so the record of *what a couple agreed and when* uses
 * one vocabulary rather than a string typed at each write site — the same
 * discipline `ruleChangeAction` applies to the audit log.
 *
 * These land in the consent history rather than the audit log on purpose: an
 * `audit_log` row records that someone *did* something, while this table is the
 * couple's record of their agreements changing, which is what a corpus edit is.
 */
export function agreementChangeKind(op: AgreementWrite["op"]): string {
	return `agreement_${op}`;
}

/** The `agreement_`-namespaced consent kinds, for selecting corpus changes out. */
export const AGREEMENT_CHANGE_PREFIX = "agreement_";
