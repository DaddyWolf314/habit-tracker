import { awaitedRulings } from "./adjudication.ts";
import type { EventType } from "./event-types.ts";
import type { EventView } from "./events.ts";
import { type Role, subjectRoleOf } from "./roles.ts";
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
	/**
	 * Events awaiting **this member's** ruling (#136, §8.1). Not "everything
	 * pending": counting a sub's own confessions back at them is the anxiety
	 * mechanic §8.3 declines, delivered as a number.
	 */
	pending_events: number;
	/**
	 * Rulings landed on this member's own events since they last looked (#136,
	 * §8.3 — "You have an update"). The sub's half of the queue signal, and the
	 * reason their count is not simply zero.
	 */
	rulings_received: number;
	/** A partner-assisted recovery is in progress and worth noticing (#41). */
	recovery_pending: boolean;
	/**
	 * Rule changes the partner has made since the viewer last acknowledged them
	 * (#64, ADR 0002; on Today since #123). Authoring is dom/switch-gated, so the
	 * sub who is bound by the rules is notified when they change — transparency
	 * standing in for a consent handshake. A count only: the badge says "N new
	 * items", never which rule changed or how. (What changed is spelled out by
	 * {@link ruleChangeNotice} — but only inside the authed app, never on the
	 * badge.)
	 */
	rule_changes: number;
	/**
	 * Agreement changes the partner has made since the viewer last acknowledged
	 * them (#121, ADR 0006). The same transparency-for-consent argument ADR 0002
	 * makes for rules, and it lands harder here: a rule change alters what a
	 * demerit is worth, an Agreement change alters what the person agreed to.
	 * Still a count only — which term changed is content, and content never
	 * reaches the badge.
	 */
	agreement_changes: number;
}

/** The single content-free unread count shown as "You have N new items". */
export function unreadCount(signals: NotificationSignals): number {
	return (
		signals.pending_events +
		signals.rulings_received +
		(signals.recovery_pending ? 1 : 0) +
		signals.rule_changes +
		signals.agreement_changes
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

/** One unseen rule change, as the viewer's Today surface receives it (#64). */
export interface RuleChangeNotice {
	kind: RuleChangeKind;
	rule_id: string;
	/** When the change was made (its `audit_log` timestamp). */
	at: number;
}

/**
 * The partner-facing sentence for one rule change (#64, user stories 33 + 35).
 * Rendered only inside the authed app — on Today since #123, where the member
 * bound by a rule they cannot author will actually see it — while the
 * notification *badge* stays a content-free count (see {@link unreadCount});
 * this is the content a member
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

/**
 * The `audit_log` action for a corpus change (#121), namespaced like
 * {@link ruleChangeAction} so the unread count can select these rows out of the
 * same log that records rule authoring and support reads.
 *
 * A corpus change writes to *both* logs, and the split is the point: the
 * `consent_history` row is the couple's record of what they agreed and when,
 * while this row carries an actor, which is what makes "changed by someone other
 * than you" answerable at all.
 */
export function agreementChangeAction(op: string): string {
	return `agreement.${op}`;
}

/** The `agreement.`-namespaced audit actions, for selecting corpus changes out. */
export const AGREEMENT_CHANGE_ACTION_PREFIX = "agreement.";

/**
 * Events awaiting **this member's** ruling (#136, handoff §8.1 — "badge on today
 * view: '2 awaiting your ruling'").
 *
 * Scoped through {@link awaitedRulings}, which already answers "may this role
 * rule this key" via the type's `adjudicated_by`. That gating is also what
 * handles a switch with no special case, exactly as the queue itself does — the
 * question is never "are you the dom", it is "is this yours to rule".
 *
 * It replaced a count of *every* pending event, which meant a sub's badge tallied
 * their own confessions awaiting the dom's ruling: a number that rises when you
 * self-report and sits there until you are judged. §8.3 asks for the opposite —
 * "quiet 'awaiting ruling' chip… No countdowns, no anxiety mechanics."
 */
export function awaitingMyRuling({
	events,
	types,
	members,
	role,
}: {
	events: EventView[];
	types: EventType[];
	members: Array<{ member_id: string; role: Role | null }>;
	role: Role | null;
}): number {
	if (role === null) return 0;
	const byId = new Map(types.map((t) => [t.id, t]));
	let count = 0;
	for (const event of events) {
		const type = byId.get(event.type);
		if (!type) continue;
		const subjectRole = subjectRoleOf(event.subject, members);
		if (awaitedRulings(event, type, role, subjectRole).length > 0) count++;
	}
	return count;
}

/**
 * Rulings landed on this member's own events since they last looked (#136,
 * handoff §8.3 — "On ruling: content-safe notification ('You have an update')").
 *
 * This half never existed. When the dom ruled, the sub's count silently *dropped*
 * — the one moment the spec calls "emotionally load-bearing in LDR play" was the
 * one moment nothing happened.
 *
 * A ruling you made yourself is not news to you, so only the other member's
 * amendments count. Each correction counts again: superseding a ruling changes
 * what the sub was told, which is a new thing to hear rather than a tidier
 * version of the old one.
 */
export function rulingsReceivedSince({
	events,
	memberId,
	seenAt,
}: {
	events: EventView[];
	memberId: string;
	seenAt: number;
}): number {
	let count = 0;
	for (const event of events) {
		if (event.actor !== memberId) continue;
		for (const amendment of event.amendments) {
			if (amendment.kind !== "adjudication") continue;
			if (amendment.actor === memberId) continue;
			if (amendment.created_at > seenAt) count++;
		}
	}
	return count;
}
