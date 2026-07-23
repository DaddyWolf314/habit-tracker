import type { Amendment, AmendmentInput } from "./amendments.ts";
import type { EventType, MetadataField } from "./event-types.ts";
import type { Event } from "./events.ts";
import { compositeMetadata, isPending, isRetracted } from "./projections.ts";
import type { MetadataValue, Role } from "./roles.ts";

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
	eventType: Pick<EventType, "metadata" | "awaiting" | "journaling">;
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
	}
}

/**
 * A `response` is the partner's warm reaction to a journal entry (ADR 0001):
 *  - it is authored by the *non-author* of the entry (a response to your own
 *    entry is meaningless — that is what `note_appended` is for);
 *  - it is only for journaling entries (the visibility axis only exists there);
 *  - it is allowed on `shared` and `sealed` entries but never on `secret` ones —
 *    the dom must not even be able to learn a secret entry exists, so the read
 *    model omits it and any response referencing it is refused up front.
 * It carries no rule effects and never touches composite metadata (see
 * `compositeMetadata`, which folds only adjudications), so nothing else here does.
 */
function validateResponse(ctx: AmendmentContext): AmendmentValidation {
	if (ctx.actorMemberId === ctx.event.actor) {
		return fail("only your partner may respond to your entry", true);
	}
	if (!ctx.eventType.journaling) {
		return fail("only a journal entry can be responded to");
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
		const valueError = checkValue(key, field, value);
		if (valueError) return fail(valueError);
		// One active ruling per key: touching an already-ruled key is only allowed
		// as an explicit correction of that ruling.
		const activeId = active.get(key);
		if (activeId !== undefined && activeId !== input.supersedes) {
			return fail(`'${key}' is already ruled; supersede the prior ruling`);
		}
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

/** Ensures a patch value fits the field's kind (mirrors the log-time check). */
function checkValue(
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
		case "ref":
			return typeof value === "string" ? null : `${key} must be a reference`;
	}
}

function fail(error: string, forbidden = false): AmendmentValidation {
	return { ok: false, error, forbidden };
}
