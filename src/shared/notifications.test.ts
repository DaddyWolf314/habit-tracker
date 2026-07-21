import { describe, expect, it } from "vitest";
import { unreadCount } from "./notifications.ts";
import { deriveEventView } from "./projections.ts";

/**
 * Content-free notifications (#42, decision #46 = in-app only). The badge is a
 * single unread *count* — "You have N new items" — and never any relationship
 * content, so a glance at a notification badge reveals nothing about the couple.
 * This pure function is the one place the count is composed.
 */

describe("unreadCount", () => {
	it("counts the items awaiting attention", () => {
		expect(unreadCount({ pending_events: 3, recovery_pending: false })).toBe(3);
	});

	it("adds one for a pending recovery a member should notice", () => {
		expect(unreadCount({ pending_events: 0, recovery_pending: true })).toBe(1);
		expect(unreadCount({ pending_events: 2, recovery_pending: true })).toBe(3);
	});

	it("is zero when nothing awaits", () => {
		expect(unreadCount({ pending_events: 0, recovery_pending: false })).toBe(0);
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

	it("the count sums only pending events and recovery — nothing else", () => {
		expect(unreadCount({ pending_events: 0, recovery_pending: false })).toBe(0);
		expect(unreadCount({ pending_events: 2, recovery_pending: false })).toBe(2);
	});
});
