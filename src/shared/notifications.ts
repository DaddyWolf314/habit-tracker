import { queueFor } from "./adjudication.ts";
import type { EventView } from "./events.ts";
import { ruleName } from "./rules.ts";
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
	 * Amendments a partner landed on this member's own events since they last
	 * looked (#136, §8.3 — "You have an update"): a ruling, or a response (#183).
	 * The sub's half of the queue signal, and the reason their count is not simply
	 * zero.
	 */
	updates_received: number;
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
	/**
	 * Rung crossings neither this member has looked at yet (#193, ADR 0015).
	 *
	 * The one signal here that is not addressed to *someone*. Every other entry
	 * counts a thing a partner did to this member — a ruling, a response, a rule
	 * they changed — and a crossing is nobody's approach: a bare logged event
	 * notifies no one, so without this a crossing reaches the dom only when the
	 * underlying event happens to be pending a ruling, and reaches the sub not at
	 * all.
	 *
	 * Counted for **both** members, unfiltered by actor, and that is the deliberate
	 * difference from {@link rule_changes}. A rule change is news only to the
	 * partner who didn't make it; a ladder is a term binding both, and hiding its
	 * state from the person it binds would make the consent record asymmetric in the
	 * one direction it must never be (Handoff §8's "no anxiety mechanics" governs
	 * pressure the *app* invents, not a term the couple agreed).
	 *
	 * Still a count, never content — which rung, on which counter, and what it
	 * costs are all inside the app.
	 */
	crossings: number;
}

/** The single content-free unread count shown as "You have N new items". */
export function unreadCount(signals: NotificationSignals): number {
	return (
		signals.pending_events +
		signals.updates_received +
		(signals.recovery_pending ? 1 : 0) +
		signals.rule_changes +
		signals.agreement_changes +
		signals.crossings
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
	/**
	 * What the rule was called at `at` (#150) — resolved by the server from the
	 * version in force then, never from the rule's name today. A later rename must
	 * not rewrite a notice the partner has already read, which is the same
	 * guarantee the effective-dated name gives the revision history (ADR 0009).
	 *
	 * Absent when nothing names it: a purge leaves no version behind, and a rule
	 * last touched before v11 has no name on record. The renderer de-slugs the id.
	 */
	name?: string;
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
 *
 * The rule is named the way it was named *then* (#150) — see
 * {@link RuleChangeNotice.name}.
 */
export function ruleChangeNotice(notice: RuleChangeNotice): string {
	const rule = `"${ruleName({ id: notice.rule_id, name: notice.name })}"`;
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
 * The queue's own fold, counted: `queueFor` already answers "is this yours to
 * rule" through the type's `adjudicated_by`, which is what handles a switch with
 * no special case, exactly as the queue panel does. The question is never "are
 * you the dom".
 *
 * It replaced a count of *every* pending event, which meant a sub's badge tallied
 * their own confessions awaiting the dom's ruling: a number that rises when you
 * self-report and sits there until you are judged. §8.3 asks for the opposite —
 * "quiet 'awaiting ruling' chip… No countdowns, no anxiety mechanics."
 */
export function awaitingMyRuling(args: Parameters<typeof queueFor>[0]): number {
	return queueFor(args).length;
}

/**
 * What a partner has said back about this member's own events since they last
 * looked (#136, handoff §8.3 — "On ruling: content-safe notification ('You have
 * an update')").
 *
 * This half never existed. When the dom ruled, the sub's count silently *dropped*
 * — the one moment the spec calls "emotionally load-bearing in LDR play" was the
 * one moment nothing happened.
 *
 * A `response` is that same moment (#183): the dom writes "proud of you" on the
 * sub's act, and while this counted rulings only, the sub was never told. So the
 * question is not "was it a ruling" but **"did my partner address this to me"** —
 * and asking that directly is why there is no `kind` filter here. It needs none:
 * `note_appended` and `retracted` are author-only by `validateAmendment`, so on
 * an event this member authored the `actor !== memberId` test already excludes
 * them, leaving exactly `adjudication | response`. A filter would restate a rule
 * validation already enforces, and would have to be revisited every time the
 * amendment vocabulary grows.
 *
 * **A bare event counts for nobody.** Logging an act notifies no one: the badge is
 * things addressed *to* you, and an act is a record, not an approach (#182). It
 * is also a count with no content by design (#42), so six acts in one scene would
 * spike the dom to "6 new items" on a badge that cannot say which — or that any
 * of them wanted anything.
 *
 * A ruling you made yourself is not news to you, so only the other member's
 * amendments count — and an *event* counts once however many times it was
 * amended. Counting each separately would inflate "N new items" for one thing
 * that happened, which is the same overstatement this exists to remove from the
 * other side of the count; two responses on one entry is one unread item for the
 * same reason a corrected ruling always was.
 */
export function updatesReceivedSince({
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
		const heard = event.amendments.some(
			(a) => a.actor !== memberId && a.created_at > seenAt,
		);
		if (heard) count++;
	}
	return count;
}
