import {
	type Amendment,
	type AmendmentInput,
	type WaivedEffect,
	waivedEffectKey,
} from "./amendments.ts";
import { checkMetadataValue, type EventType } from "./event-types.ts";
import type { Event } from "./events.ts";
import { compositeMetadata, isPending, isRetracted } from "./projections.ts";
import { type Role, rolePermits } from "./roles.ts";

/**
 * Authoring-time amendment validation (handoff §4.2). An amendment is checked
 * against the target event, its type schema, the actor's role, and the prior
 * amendments *before it is written* — the log is append-only, so a bad ruling
 * must be refused up front rather than swept up on read. Pure and dependency-
 * free (like `rule-validation.ts`) so the client editor and the DO agree
 * exactly. Enforces the three invariants of §4.2:
 *   - an adjudication may only touch keys the actor's role is `adjudicated_by`
 *     for, and only one *active* ruling exists per key (a correction supersedes
 *     the prior ruling; it never deletes it);
 *   - a `note_appended` is the author annotating their own still-pending event;
 *   - a `retracted` is the author withdrawing their own still-pending event, and
 *     is terminal — nothing may amend an event that has been retracted.
 */

/** The slice of state an amendment is judged against. */
export interface AmendmentContext {
	event: Pick<Event, "metadata" | "actor" | "visibility">;
	eventType: Pick<EventType, "metadata" | "awaiting">;
	/** The role of the member submitting the amendment. */
	actorRole: Role | null;
	/** The member id submitting the amendment (server-authenticated). */
	actorMemberId: string;
	/** Amendments already recorded against this event. */
	amendments: Amendment[];
	/**
	 * The target event's resolved subject role (ADR 0003), via
	 * `resolveSubjectRole` — subject-qualified awaiting entries gate pending (and
	 * thus note/retract windows) only when it matches.
	 */
	subjectRole?: Role;
}

export type AmendmentValidation =
	| { ok: true }
	/** `forbidden` marks an authorization refusal (a 403) vs a malformed/conflicting one (a 400). */
	| { ok: false; error: string; forbidden?: boolean };

/**
 * The roles that may waive an effect (ADR 0016) — the roles that may author
 * rules (ADR 0002). Whoever may write a rule may overrule its output.
 *
 * Deliberately *not* the type's `adjudicated_by`, which was the obvious
 * alternative and is wrong for the case waiving exists to serve: an
 * unconditional effect like R2's (`ritual_completed AND late=true → demerits
 * +1`) sits on a type with no awaited key at all, so an `adjudicated_by` gate
 * would leave exactly that effect ungated.
 */
export const WAIVER_ROLES: readonly Role[] = ["dom", "switch"];

/**
 * Whether a role may waive an effect. Exported so a surface can gate the
 * affordance on the same question the server gates the write on, in the shape
 * `canRespondTo` established — a second, client-side rule about who may waive is
 * how a screen ends up offering a button whose write is refused.
 */
export function canWaiveEffects(role: Role | null | undefined): boolean {
	return rolePermits(role, WAIVER_ROLES);
}

/** The keys a role may rule on for a type — its `adjudicated_by` grants. */
export function adjudicableKeys(
	type: Pick<EventType, "metadata">,
	role: Role | null,
): string[] {
	if (role === null) return [];
	return Object.entries(type.metadata)
		.filter(([, field]) => field.adjudicated_by?.includes(role))
		.map(([key]) => key);
}

/** Validates a proposed amendment. First failure wins. */
export function validateAmendment(
	input: AmendmentInput,
	ctx: AmendmentContext,
): AmendmentValidation {
	// Retraction is terminal: an event that left the queue can't be amended again.
	if (isRetracted(ctx.amendments)) {
		return fail("this event has been retracted");
	}

	const composite = compositeMetadata(ctx.event, ctx.amendments);
	const pending = isPending(ctx.eventType, composite, false, ctx.subjectRole);

	switch (input.kind) {
		case "adjudication":
			return validateAdjudication(input, ctx);
		case "note_appended":
			if (ctx.actorMemberId !== ctx.event.actor) {
				return fail("only the author may annotate their own event", true);
			}
			if (!pending) return fail("this event is no longer pending");
			return { ok: true };
		case "retracted":
			if (ctx.actorMemberId !== ctx.event.actor) {
				return fail("only the author may retract their own event", true);
			}
			if (!pending) return fail("only a pending event can be retracted");
			return { ok: true };
		case "response":
			return validateResponse(ctx);
		case "waiver":
			return validateWaivedEffects(input.waived, ctx);
	}
}

/**
 * The shape and authorization checks a waiver's effect list must pass (ADR
 * 0016), shared by the standalone `waiver` and by the `waive` list an
 * adjudication carries from the confirm sheet — the two are the same act with
 * different timing, so they may not drift on who is allowed to perform it.
 *
 * What is *not* checked here: whether the named effects actually fired. That is a
 * question about the trace, which this pure module deliberately cannot see; the
 * DO answers it before writing, so a waiver never names an effect that does not
 * exist. Nor is the event's pending status consulted — waiving an effect is not
 * ruling on a fact, and the effects most in need of it (R2's, at append) sit on
 * events that were never pending at all.
 */
function validateWaivedEffects(
	waived: WaivedEffect[],
	ctx: AmendmentContext,
): AmendmentValidation {
	if (!canWaiveEffects(ctx.actorRole)) {
		return fail("your role may not waive an effect", true);
	}
	if (waived.length === 0) return fail("a waiver must name an effect");
	const seen = new Set<string>();
	for (const effect of waived) {
		const key = waivedEffectKey(effect);
		if (seen.has(key)) return fail(`waived twice: ${key}`);
		seen.add(key);
	}
	return { ok: true };
}

/**
 * A `response` is the partner's warm reaction to something the other logged
 * (ADR 0001, broadened by ADR 0007):
 *  - it is authored by the *non-author* of the entry (a response to your own
 *    entry is meaningless — that is what `note_appended` is for);
 *  - it is allowed on `shared` content and on `sealed` journal entries, but never
 *    on `secret` ones — the dom must not even be able to learn a secret entry
 *    exists, so the read model omits it and any response referencing it is
 *    refused up front.
 * It carries no rule effects and never touches composite metadata (see
 * `compositeMetadata`, which folds only adjudications), so nothing else here does.
 *
 * The gate used to be "is this a journaling type", and ADR 0001 gave a specific
 * reason: "the visibility axis only exists there". So the restriction was always
 * about guarding sealed and secret prose, and asking after the visibility directly
 * is that same guard stated honestly — it refuses exactly what it was aimed at and
 * nothing more. What it stops refusing is a `check_in`, which is not
 * journaling-capable and therefore always `shared`: there is no visibility to leak,
 * and a response to one is what closes a conversation flag (ADR 0007).
 */
function validateResponse(ctx: AmendmentContext): AmendmentValidation {
	if (ctx.actorMemberId === ctx.event.actor) {
		return fail("only your partner may respond to your entry", true);
	}
	if (ctx.event.visibility === "secret") {
		return fail("a secret entry cannot be responded to", true);
	}
	return { ok: true };
}

function validateAdjudication(
	input: Extract<AmendmentInput, { kind: "adjudication" }>,
	ctx: AmendmentContext,
): AmendmentValidation {
	const keys = Object.keys(input.patch);
	if (keys.length === 0) return fail("an adjudication must patch a key");

	// `supersedes`, when present, must name a live (existing, not-yet-superseded)
	// adjudication — you correct the ruling that is currently in force.
	const superseded = supersededIds(ctx.amendments);
	if (input.supersedes !== undefined) {
		const target = ctx.amendments.find((a) => a.id === input.supersedes);
		if (!target || target.kind !== "adjudication") {
			return fail(`supersedes an unknown ruling: ${input.supersedes}`);
		}
		if (superseded.has(target.id)) {
			return fail("supersedes a ruling that was already corrected");
		}
	}

	const active = activeRulingByKey(ctx.amendments, superseded);
	for (const [key, value] of Object.entries(input.patch)) {
		const field = ctx.eventType.metadata[key];
		if (!field) return fail(`unknown metadata key: ${key}`);
		if (!field.adjudicated_by?.includes(ctx.actorRole as Role)) {
			return fail(`your role may not adjudicate: ${key}`, true);
		}
		const valueError = checkMetadataValue(key, field, value);
		if (valueError) return fail(valueError);
		// One active ruling per key: touching an already-ruled key is only allowed
		// as an explicit correction of that ruling.
		const activeId = active.get(key);
		if (activeId !== undefined && activeId !== input.supersedes) {
			return fail(`'${key}' is already ruled; supersede the prior ruling`);
		}
	}
	// Effects unchecked on the confirm sheet ride along with the ruling (ADR
	// 0016), and are gated on authoring a rule rather than on adjudicating this
	// key: a role may be `adjudicated_by` for a key on a custom type without being
	// allowed to overrule what the couple's rules do with it.
	// An empty list is an ordinary ruling that waived nothing, not a waiver with no
	// effects — refusing it would gate every adjudicator on the rule-authoring
	// roles for sending a field they meant as absent.
	if (input.waive?.length) {
		return validateWaivedEffects(input.waive, ctx);
	}
	return { ok: true };
}

/** Ids of adjudications that a later correction has superseded. */
function supersededIds(amendments: Amendment[]): Set<string> {
	const ids = new Set<string>();
	for (const a of amendments) {
		if (a.kind === "adjudication" && a.supersedes) ids.add(a.supersedes);
	}
	return ids;
}

/** Maps each ruled key to the id of the adjudication currently in force. */
function activeRulingByKey(
	amendments: Amendment[],
	superseded: Set<string>,
): Map<string, string> {
	const byKey = new Map<string, string>();
	for (const a of [...amendments].sort((x, y) => x.created_at - y.created_at)) {
		if (a.kind !== "adjudication" || superseded.has(a.id)) continue;
		for (const key of Object.keys(a.patch)) byKey.set(key, a.id);
	}
	return byKey;
}

function fail(error: string, forbidden = false): AmendmentValidation {
	return { ok: false, error, forbidden };
}
