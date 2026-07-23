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
	 * Rule changes the partner has made since the viewer last acknowledged them
	 * on the rules screen (#64, ADR 0002). Authoring is dom/switch-gated, so the
	 * sub who is bound by the rules is notified when they change — transparency
	 * standing in for a consent handshake. A count only: the badge says "N new
	 * items", never which rule changed or how. (What changed is spelled out by
	 * {@link ruleChangeNotice} — but only inside the authed rules screen, never
	 * on the badge.)
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
 * The kinds of rule change a member is notified of (#64). The first five are the
 * ADR 0002 authoring vocabulary — every action a dom/switch takes is one of them
 * (a "remove" of a fired or pack rule *is* a `disable`; `purge` is the hard
 * delete of a never-fired custom rule). `upstream_changed` is the one
 * system-actor kind: a pack bump found a new default for a rule the couple has
 * adopted. Each writes an `audit_log` row and bumps the unread count of every
 * member who didn't make the change.
 */
export type RuleChangeKind =
	| "create"
	| "edit"
	| "enable"
	| "disable"
	| "purge"
	| "upstream_changed";

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

/**
 * Decodes a stored audit action back to its change kind — the inverse of
 * {@link ruleChangeAction}, kept beside it so the vocabulary round-trips in one
 * place. Returns null for an action outside the vocabulary rather than throwing:
 * the audit log is append-only, so rows written under a retired kind must still
 * read back harmlessly. (`rule.delete` predates the ADR 0002 `purge` naming and
 * decodes to it.)
 */
export function ruleChangeKindFromAction(
	action: string,
): RuleChangeKind | null {
	if (!action.startsWith(RULE_CHANGE_ACTION_PREFIX)) return null;
	const kind = action.slice(RULE_CHANGE_ACTION_PREFIX.length);
	if (kind === "delete") return "purge";
	const known: RuleChangeKind[] = [
		"create",
		"edit",
		"enable",
		"disable",
		"purge",
		"upstream_changed",
	];
	return known.includes(kind as RuleChangeKind)
		? (kind as RuleChangeKind)
		: null;
}

/** One unseen rule change, as the rules screen receives it (#64, user story 35). */
export interface RuleChangeNotice {
	kind: RuleChangeKind;
	rule_id: string;
	/** When the change was made (its `audit_log` timestamp). */
	at: number;
}

/**
 * The partner-facing sentence for one rule change (#64, user stories 33 + 35).
 * Rendered only inside the authed rules screen — the notification *badge* stays
 * a content-free count (see {@link unreadCount}); this is the content a member
 * sees once they're looking at the rules themselves. Viewer-relative: authoring
 * kinds are always changes the *other* member made (a member's own changes need
 * no notice), and `upstream_changed` is the app's pack, not a partner.
 */
export function ruleChangeNotice(notice: RuleChangeNotice): string {
	const rule = `"${notice.rule_id}"`;
	switch (notice.kind) {
		case "create":
			return `Your partner added the rule ${rule}.`;
		case "edit":
			return `Your partner changed the rule ${rule}.`;
		case "enable":
			return `Your partner turned the rule ${rule} on.`;
		case "disable":
			return `Your partner turned the rule ${rule} off.`;
		case "purge":
			return `Your partner removed the rule ${rule}.`;
		case "upstream_changed":
			return `The default for the rule ${rule} changed in an app update — your edited version still applies.`;
	}
}
