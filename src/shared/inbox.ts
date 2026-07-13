/**
 * Content-free notifications (handoff §3.5, #42). Discretion is a product
 * requirement: a notification may reveal only a *count*, never anything about
 * the relationship. Decision #46 settles the transport as in-app only for v1, so
 * this is surfaced as an unread badge the client polls — "You have N new items."
 * This module is the single place the count is composed, keeping the "count, not
 * content" contract in one auditable spot.
 */

/** The couple-side signals that feed the unread count. Counts only — no content. */
export interface InboxSignals {
	/** Events currently awaiting an adjudication (the queue). */
	pending_events: number;
	/** A partner-assisted recovery is in progress and worth noticing (#41). */
	recovery_pending: boolean;
}

/** The single content-free unread count shown as "You have N new items". */
export function inboxUnreadCount(signals: InboxSignals): number {
	return signals.pending_events + (signals.recovery_pending ? 1 : 0);
}
