import { describe, expect, it } from "vitest";
import {
	type NotificationSignals,
	type RuleChangeKind,
	ruleChangeAction,
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
	it("namespaces each change kind under rule.", () => {
		const kinds: RuleChangeKind[] = [
			"create",
			"edit",
			"enable",
			"disable",
			"delete",
		];
		expect(kinds.map(ruleChangeAction)).toEqual([
			"rule.create",
			"rule.edit",
			"rule.enable",
			"rule.disable",
			"rule.delete",
		]);
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
