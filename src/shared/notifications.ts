/**
 * Content-free notifications (handoff §3.5, #42). Discretion is a product
 * requirement: a notification may reveal only a *count*, never anything about
 * the relationship. Decision #46 settles the transport as in-app only for v1, so
 * this is surfaced as an unread badge the client polls — "You have N new items."
 * This module is the single place the count is composed, keeping the "count, not
 * content" contract in one auditable spot.
 */

/** The couple-side signals that feed the unread count. Counts only — no content. */
export interface NotificationSignals {
	/** Events currently awaiting an adjudication (the queue). */
	pending_events: number;
	/** A partner-assisted recovery is in progress and worth noticing (#41). */
	recovery_pending: boolean;
	/**
	 * Rule changes the partner has made since the viewer last looked at the rules
	 * screen (#64, ADR 0002). Authoring is dom/switch-gated, so the sub who is
	 * bound by the rules is notified when they change — transparency standing in
	 * for a consent handshake. A count only: the badge says "N new items", never
	 * which rule changed or how.
	 */
	rule_changes: number;
}

/** The single content-free unread count shown as "You have N new items". */
export function unreadCount(signals: NotificationSignals): number {
	return (
		signals.pending_events +
		(signals.recovery_pending ? 1 : 0) +
		signals.rule_changes
	);
}

/**
 * The kinds of rule change the partner is notified of (#64). Every authoring
 * action a dom/switch takes is one of these; each writes an `audit_log` row and
 * bumps the partner's unread count.
 */
export type RuleChangeKind =
	| "create"
	| "edit"
	| "enable"
	| "disable"
	| "delete";

/**
 * Composes the `audit_log` action string for a rule change. This is the single
 * place the change-kind vocabulary is defined, so the dom-facing accountability
 * record and the partner-facing count stay in agreement. The action namespaces
 * under `rule.` so the notification count can select rule changes out of the same
 * audit log that also records support-introspection reads.
 */
export function ruleChangeAction(kind: RuleChangeKind): string {
	return `rule.${kind}`;
}

/** The `rule.`-namespaced audit actions, for selecting rule changes from the log. */
export const RULE_CHANGE_ACTION_PREFIX = "rule.";
