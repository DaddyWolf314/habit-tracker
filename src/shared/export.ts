import type { AgreementKind, AgreementVersion } from "./agreements.ts";
import type { Amendment } from "./amendments.ts";
import type { AnchorView } from "./anchors.ts";
import type { Counter } from "./counters.ts";
import type { Event } from "./events.ts";
import type { ExportRow } from "./identity.ts";
import type { Rule } from "./rules.ts";
import type { TimerView } from "./timers.ts";

/**
 * Flatteners for the member export (handoff §2, abuse-edge). The export is a
 * feature we write, not a dashboard button: a member's full view of the
 * relationship as portable JSON. Each function turns one domain object into an
 * {@link ExportRow} — deliberately flat so it crosses the DO RPC boundary
 * cleanly. Two rules keep a reconstructor honest: nested values are serialized
 * as JSON strings (never nested objects), and absent optionals become `null`
 * (never `undefined`, which JSON silently drops). The event log and its
 * amendments are exported separately so `events + amendments` still reconstruct
 * the composite truth (handoff §4.2) without the export pre-folding it.
 */

/** An event as an export row. Metadata is serialized; optionals become null. */
export function eventToExportRow(event: Event): ExportRow {
	return {
		id: event.id,
		type: event.type,
		actor: event.actor,
		subject: event.subject ?? null,
		occurred_at: event.occurred_at,
		logged_at: event.logged_at,
		metadata: JSON.stringify(event.metadata),
		note: event.note ?? null,
		visibility: event.visibility,
	};
}

/**
 * A counter as an export row — full definition, nothing dropped. `streak` binds
 * this counter to its target-counter (handoff §4.4); dropping it would demote a
 * reconstructed streak to an ordinary counter the rollover never advances, so it
 * is serialized rather than omitted.
 */
export function counterToExportRow(counter: Counter): ExportRow {
	return {
		id: counter.id,
		name: counter.name,
		valence: counter.valence,
		daily_target: counter.daily_target ?? null,
		weekly_target: counter.weekly_target ?? null,
		// Which way those targets are met (ADR 0015). Serialized for the same reason
		// `streak` below is: dropping it would export a cap as a floor, which turns
		// "stayed at zero" into "reached zero" — met on every row, for ever.
		target_direction: counter.target_direction,
		reset: counter.reset,
		streak: counter.streak ? JSON.stringify(counter.streak) : null,
		modify_permission: JSON.stringify(counter.modify_permission),
		value: counter.value,
		updated_at: counter.updated_at,
	};
}

/**
 * An amendment as an export row. Amendments are a discriminated union (handoff
 * §4.2); the row is the widest shape, with fields absent on a given kind set to
 * null. `patch`/`supersedes` belong to adjudications only; `note` is required on
 * `note_appended` and optional elsewhere.
 */
export function amendmentToExportRow(amendment: Amendment): ExportRow {
	return {
		id: amendment.id,
		target_event_id: amendment.target_event_id,
		kind: amendment.kind,
		actor: amendment.actor,
		created_at: amendment.created_at,
		patch:
			amendment.kind === "adjudication"
				? JSON.stringify(amendment.patch)
				: null,
		note: "note" in amendment ? (amendment.note ?? null) : null,
		supersedes:
			amendment.kind === "adjudication" ? (amendment.supersedes ?? null) : null,
		// A waiver's whole content is *which* effects it overruled (ADR 0016), so
		// leaving these out would export the fact that a mercy happened without the
		// fact of what it was — the export is the couple's record, and a waiver with
		// no effects named is not one.
		waived:
			amendment.kind === "waiver" ? JSON.stringify(amendment.waived) : null,
		suppresses:
			amendment.kind === "waiver" ? (amendment.suppresses ?? null) : null,
	};
}

/** A rule as an export row. Condition and effects are serialized. */
export function ruleToExportRow(rule: Rule): ExportRow {
	return {
		id: rule.id,
		// What the couple calls it (#150) — authored content, so it leaves with the
		// rest of their data. Null for a rule nobody has named; the export carries
		// what is on record, and does not de-slug an id into a name they never wrote.
		name: rule.name ?? null,
		condition: JSON.stringify(rule.condition),
		effects: JSON.stringify(rule.effects),
		enabled: rule.enabled,
	};
}

/** A timer view as an export row. The metadata `match` is serialized. */
export function timerToExportRow(timer: TimerView): ExportRow {
	return {
		id: timer.id,
		kind: timer.kind,
		timer: timer.timer,
		tag: timer.tag,
		match: JSON.stringify(timer.match),
		opened_at: timer.opened_at,
		closed_at: timer.closed_at,
		status: timer.status,
		duration_ms: timer.duration_ms,
		deadline_at: timer.deadline_at,
		paused_at: timer.paused_at,
		remaining_ms: timer.remaining_ms,
	};
}

/** An anchor snapshot as an export row — already flat, carried verbatim. */
export function anchorToExportRow(anchor: AnchorView): ExportRow {
	return {
		anchor: anchor.anchor,
		since: anchor.since,
		elapsed_ms: anchor.elapsed_ms,
		elapsed_days: anchor.elapsed_days,
	};
}

/**
 * One Agreement **version** as an export row (#121, ADR 0006) — flattened per
 * version rather than per term, because a citation resolves to whichever wording
 * was in force when the act happened. An export carrying only today's text would
 * leave every past citation unreadable, which is the same readability loss ADR
 * 0005 accepted for a minted id and this can avoid.
 */
export function agreementVersionToExportRow(
	agreementId: string,
	kind: string,
	version: AgreementVersion,
	subject?: string,
): ExportRow {
	return {
		agreement_id: agreementId,
		kind,
		// Who the term is about (#160, ADR 0010) — a member id, repeated on every one
		// of the term's rows because it belongs to the identity rather than the
		// version. Null for an `unscoped` kind, where there is no subject to name.
		subject: subject ?? null,
		effective_from: version.effective_from,
		name: version.name,
		text: version.text,
		review_cadence_days: version.review_cadence_days ?? null,
		retired: version.retired,
	};
}

/**
 * One Agreement kind as an export row — who may hold that category, and how
 * authorship of one of its entries narrows to a member (ADR 0010).
 *
 * `adopted` and `upstream_changed` are deliberately absent, as they are from
 * `ruleToExportRow`: they are pack-tracking state, not the couple's content.
 */
export function agreementKindToExportRow(kind: AgreementKind): ExportRow {
	return {
		id: kind.id,
		label: kind.label,
		author_permission: JSON.stringify(kind.author_permission),
		author_scope: kind.author_scope,
	};
}
