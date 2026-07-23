import { describe, expect, it } from "vitest";
import {
	type NotificationSignals,
	type RuleChangeKind,
	ruleChangeAction,
	ruleChangeKindFromAction,
	ruleChangeNotice,
	unreadCount,
} from "./notifications.ts";
import { deriveEventView } from "./projections.ts";

/** Signals with everything quiet, overridden per test. */
function signals(
	partial: Partial<NotificationSignals> = {},
): NotificationSignals {
	return {
		pending_events: 0,
		recovery_pending: false,
		rule_changes: 0,
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
	// Content lives only inside the authed rules screen; the badge stays a
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
