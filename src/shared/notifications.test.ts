import { describe, expect, it } from "vitest";
import type { Amendment } from "./amendments.ts";
import type { EventType } from "./event-types.ts";
import type { EventView } from "./events.ts";
import type { RoleMember } from "./identity.ts";
import {
	AGREEMENT_CHANGE_ACTION_PREFIX,
	agreementChangeAction,
	awaitingMyRuling,
	type NotificationSignals,
	RULE_CHANGE_ACTION_PREFIX,
	type RuleChangeKind,
	ruleChangeAction,
	ruleChangeKindFromAction,
	ruleChangeNotice,
	rulingsReceivedSince,
	unreadCount,
} from "./notifications.ts";
import { deriveEventView } from "./projections.ts";
import type { Role } from "./roles.ts";

/** Signals with everything quiet, overridden per test. */
function signals(
	partial: Partial<NotificationSignals> = {},
): NotificationSignals {
	return {
		pending_events: 0,
		rulings_received: 0,
		recovery_pending: false,
		rule_changes: 0,
		agreement_changes: 0,
		...partial,
	};
}

/**
 * Content-free notifications (#42, decision #46 = in-app only). The badge is a
 * single unread *count* — "You have N new items" — and never any relationship
 * content, so a glance at a notification badge reveals nothing about the couple.
 * This pure function is the one place the count is composed.
 */

describe("unreadCount", () => {
	it("counts the items awaiting attention", () => {
		expect(unreadCount(signals({ pending_events: 3 }))).toBe(3);
	});

	it("adds one for a pending recovery a member should notice", () => {
		expect(unreadCount(signals({ recovery_pending: true }))).toBe(1);
		expect(
			unreadCount(signals({ pending_events: 2, recovery_pending: true })),
		).toBe(3);
	});

	it("adds the partner's rule changes since the viewer last looked (#64)", () => {
		expect(unreadCount(signals({ rule_changes: 2 }))).toBe(2);
		expect(
			unreadCount(
				signals({ pending_events: 1, recovery_pending: true, rule_changes: 3 }),
			),
		).toBe(5);
	});

	it("is zero when nothing awaits", () => {
		expect(unreadCount(signals())).toBe(0);
	});
});

describe("ruleChangeAction (#64) — one vocabulary for audit + count", () => {
	it("namespaces each change kind under rule., in the ADR 0002 vocabulary", () => {
		const kinds: RuleChangeKind[] = [
			"create",
			"edit",
			"enable",
			"disable",
			"purge",
			"upstream_changed",
		];
		expect(kinds.map(ruleChangeAction)).toEqual([
			"rule.create",
			"rule.edit",
			"rule.enable",
			"rule.disable",
			"rule.purge",
			"rule.upstream_changed",
		]);
	});

	it("round-trips every kind back from its stored action", () => {
		const kinds: RuleChangeKind[] = [
			"create",
			"edit",
			"enable",
			"disable",
			"purge",
			"upstream_changed",
		];
		for (const kind of kinds) {
			expect(ruleChangeKindFromAction(ruleChangeAction(kind))).toBe(kind);
		}
	});

	it("decodes legacy rule.delete rows as purge, and unknown actions as null", () => {
		// The audit log is append-only: rows written before the ADR 0002 `purge`
		// naming must still read back, and a non-rule action never decodes.
		expect(ruleChangeKindFromAction("rule.delete")).toBe("purge");
		expect(ruleChangeKindFromAction("rule.frobnicate")).toBeNull();
		expect(ruleChangeKindFromAction("introspection.read")).toBeNull();
	});
});

describe("ruleChangeNotice (#64, user stories 33 + 35) — in-app content, per kind", () => {
	// Content lives only inside the authed app (Today, #123); the badge stays a
	// content-free count. Each change kind composes its own sentence, so the
	// member bound by the rules always learns what changed, not just that
	// something did.
	it("composes a distinct partner-facing sentence for each change kind", () => {
		const at = 1;
		expect(ruleChangeNotice({ kind: "create", rule_id: "custom-x", at })).toBe(
			'Your partner added the rule "custom-x".',
		);
		expect(ruleChangeNotice({ kind: "edit", rule_id: "R2", at })).toBe(
			'Your partner changed the rule "R2".',
		);
		expect(ruleChangeNotice({ kind: "enable", rule_id: "R2", at })).toBe(
			'Your partner turned the rule "R2" on.',
		);
		expect(ruleChangeNotice({ kind: "disable", rule_id: "R2", at })).toBe(
			'Your partner turned the rule "R2" off.',
		);
		expect(ruleChangeNotice({ kind: "purge", rule_id: "custom-x", at })).toBe(
			'Your partner removed the rule "custom-x".',
		);
	});

	it("attributes an upstream default change to the app, not the partner", () => {
		const notice = ruleChangeNotice({
			kind: "upstream_changed",
			rule_id: "R2",
			at: 1,
		});
		expect(notice).not.toContain("partner");
		expect(notice).toBe(
			'The default for the rule "R2" changed in an app update — your edited version still applies.',
		);
	});
});

describe("no hidden journal entry can leak into the badge (#60, ADR 0001)", () => {
	// The badge is composed purely from the two count signals — there is no
	// per-event or visibility input — and the DO fills `pending_events` by counting
	// the `pending` views of the (already visibility-funnelled) log. A journal
	// entry awaits nothing, so a sealed/secret entry is never `pending` and can
	// never inflate a partner's count, even before the funnel drops it.
	it("a journal entry at any visibility is never pending", () => {
		for (const visibility of ["shared", "sealed", "secret"] as const) {
			const view = deriveEventView(
				{
					id: "j1",
					type: "journal_entry",
					actor: "sub-1",
					occurred_at: 1,
					logged_at: 1,
					metadata: {},
					note: "reflection",
					visibility,
				},
				[],
				{ awaiting: [] },
			);
			expect(view.pending).toBe(false);
		}
	});

	it("the count sums only the count signals — no per-event content", () => {
		expect(unreadCount(signals())).toBe(0);
		expect(unreadCount(signals({ pending_events: 2 }))).toBe(2);
	});
});

describe("a never-pending dom-subject event can't inflate the badge (#75, ADR 0003)", () => {
	// `pending_events` is the badge's only per-event signal, and the DO fills it
	// by counting the `pending` views of the log. An awaiting entry qualified
	// `sub` gates only a sub-subject event, so a dom-subject event with the key
	// unset is never pending — no queue card, and nothing for the badge to count.
	const type = {
		awaiting: [{ key: "permitted", subject_role: "sub" as const }],
	};
	const orgasm = (subject: string) => ({
		id: "o1",
		type: "orgasm",
		actor: "dom-1",
		subject,
		occurred_at: 1,
		logged_at: 1,
		metadata: {},
		visibility: "shared" as const,
	});

	it("a dom-subject event awaited only for the sub is never pending", () => {
		const view = deriveEventView(orgasm("dom-1"), [], type, "dom");
		expect(view.pending).toBe(false);
		expect(
			unreadCount(
				signals({ pending_events: [view].filter((v) => v.pending).length }),
			),
		).toBe(0);
	});

	it("the same event about the sub stays pending, and counts", () => {
		const view = deriveEventView(orgasm("sub-1"), [], type, "sub");
		expect(view.pending).toBe(true);
		expect(
			unreadCount(
				signals({ pending_events: [view].filter((v) => v.pending).length }),
			),
		).toBe(1);
	});
});

describe("agreement changes in the count (#121, ADR 0006)", () => {
	it("counts a partner's corpus change like a rule change", () => {
		// ADR 0002's transparency-for-consent argument, applied where it lands
		// harder: a rule change alters what a demerit is worth, an Agreement
		// change alters what the person agreed to.
		expect(unreadCount(signals({ agreement_changes: 2 }))).toBe(2);
	});

	it("adds to the other signals rather than replacing them", () => {
		expect(
			unreadCount(
				signals({ pending_events: 1, rule_changes: 1, agreement_changes: 1 }),
			),
		).toBe(3);
	});

	it("namespaces its audit action so corpus changes select out", () => {
		expect(agreementChangeAction("revise")).toBe("agreement.revise");
		expect(
			agreementChangeAction("retire").startsWith(
				AGREEMENT_CHANGE_ACTION_PREFIX,
			),
		).toBe(true);
		// Distinct from the rule namespace, or one would count the other.
		expect(
			agreementChangeAction("revise").startsWith(RULE_CHANGE_ACTION_PREFIX),
		).toBe(false);
	});
});

/**
 * The adjudication signal (#136, handoff §8.1/§8.3). Two shipped defects, both
 * about the count meaning the wrong thing:
 *
 *  - it counted *every* pending event, so a sub's badge tallied their own
 *    confessions awaiting the dom's ruling — the "anxiety mechanic" §8.3
 *    forbids, delivered as a number;
 *  - a ruling notified nobody, so the one moment §8.3 calls "emotionally
 *    load-bearing" was the one moment the count silently *dropped*.
 *
 * Both halves are answered by the same rule: the count means what is *yours* to
 * act on or hear about.
 */

const INFRACTION: EventType = {
	id: "infraction",
	label: "Infraction",
	valence: "negative",
	log_permission: ["dom", "sub", "switch"],
	subject_required: false,
	metadata: {
		severity: {
			kind: "enum",
			options: ["minor", "major"],
			label: "Severity",
			required: false,
			set_permission: ["dom", "sub", "switch"],
			adjudicated_by: ["dom"],
		},
	},
	awaiting: ["severity"],
	journaling: false,
};

const MEMBERS: RoleMember[] = [
	{ member_id: "dom1", role: "dom", is_self: false },
	{ member_id: "sub1", role: "sub", is_self: false },
];

function pendingEvent(over: Partial<EventView> = {}): EventView {
	return {
		id: "e1",
		type: "infraction",
		actor: "sub1",
		occurred_at: 1_000,
		logged_at: 1_000,
		metadata: {},
		visibility: "shared",
		amendments: [],
		composite_metadata: {},
		pending: true,
		retracted: false,
		...over,
	} as EventView;
}

function ruling(over: Partial<Amendment> = {}): Amendment {
	return {
		id: "a1",
		target_event_id: "e1",
		kind: "adjudication",
		actor: "dom1",
		created_at: 5_000,
		patch: { severity: "minor" },
		...over,
	} as Amendment;
}

describe("awaitingMyRuling (#136, §8.1)", () => {
	const args = (role: Role | null) => ({
		events: [pendingEvent()],
		types: [INFRACTION],
		members: MEMBERS,
		role,
	});

	it("counts an event this role may rule on", () => {
		expect(awaitingMyRuling(args("dom"))).toBe(1);
	});

	it("counts nothing for the role that cannot rule it", () => {
		// The defect: a sub's badge used to include this, turning their own
		// confession into a number that sits there until they are judged.
		expect(awaitingMyRuling(args("sub"))).toBe(0);
	});

	it("counts nothing before roles are confirmed", () => {
		expect(awaitingMyRuling(args(null))).toBe(0);
	});

	it("ignores a retracted event", () => {
		expect(
			awaitingMyRuling({
				...args("dom"),
				events: [pendingEvent({ retracted: true })],
			}),
		).toBe(0);
	});

	it("ignores an event already ruled", () => {
		expect(
			awaitingMyRuling({
				...args("dom"),
				events: [
					pendingEvent({
						pending: false,
						composite_metadata: { severity: "minor" },
					}),
				],
			}),
		).toBe(0);
	});

	it("counts a switch who holds the adjudicating role", () => {
		// Gating on `adjudicated_by` rather than the role name is what handles a
		// switch with no special case, exactly as the queue itself already does.
		const type = {
			...INFRACTION,
			metadata: {
				...INFRACTION.metadata,
				severity: {
					...INFRACTION.metadata.severity,
					adjudicated_by: ["dom", "switch"],
				},
			},
		} as EventType;
		expect(awaitingMyRuling({ ...args("switch"), types: [type] })).toBe(1);
	});
});

describe("rulingsReceivedSince (#136, §8.3)", () => {
	const ruled = pendingEvent({
		pending: false,
		composite_metadata: { severity: "minor" },
		amendments: [ruling()],
	});

	it("counts a ruling on my own event", () => {
		// The half that never existed: "receiving the ruling is emotionally
		// load-bearing in LDR play", and nothing told them.
		expect(
			rulingsReceivedSince({ events: [ruled], memberId: "sub1", seenAt: 0 }),
		).toBe(1);
	});

	it("counts nothing once seen", () => {
		expect(
			rulingsReceivedSince({
				events: [ruled],
				memberId: "sub1",
				seenAt: 9_000,
			}),
		).toBe(0);
	});

	it("does not count a ruling I made myself", () => {
		// A ruling is news to the person it lands on, not the one who made it.
		expect(
			rulingsReceivedSince({ events: [ruled], memberId: "dom1", seenAt: 0 }),
		).toBe(0);
	});

	it("does not count a ruling on someone else's event", () => {
		const theirs = pendingEvent({
			actor: "dom1",
			amendments: [ruling({ actor: "sub1" })],
		});
		expect(
			rulingsReceivedSince({ events: [theirs], memberId: "sub1", seenAt: 0 }),
		).toBe(0);
	});

	it("ignores amendments that are not rulings", () => {
		// A note the author appended to their own event is not an update to hear.
		const noted = pendingEvent({
			amendments: [
				{ ...ruling(), kind: "note_appended", note: "context" } as Amendment,
			],
		});
		expect(
			rulingsReceivedSince({ events: [noted], memberId: "sub1", seenAt: 0 }),
		).toBe(0);
	});

	it("counts each correction, since each is a new thing to hear", () => {
		const corrected = pendingEvent({
			amendments: [
				ruling(),
				ruling({ id: "a2", created_at: 6_000, supersedes: "a1" }),
			],
		});
		expect(
			rulingsReceivedSince({
				events: [corrected],
				memberId: "sub1",
				seenAt: 0,
			}),
		).toBe(2);
	});
});
