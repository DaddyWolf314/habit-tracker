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
	};
}

/** A rule as an export row. Condition and effects are serialized. */
export function ruleToExportRow(rule: Rule): ExportRow {
	return {
		id: rule.id,
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
