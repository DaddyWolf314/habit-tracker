import { describe, expect, it } from "vitest";
import { inboxUnreadCount } from "./inbox.ts";

/**
 * Content-free notifications (#42, decision #46 = in-app only). The inbox is a
 * single unread *count* — "You have N new items" — and never any relationship
 * content, so a glance at a notification badge reveals nothing about the couple.
 * This pure function is the one place the count is composed.
 */

describe("inboxUnreadCount", () => {
	it("counts the items awaiting attention", () => {
		expect(
			inboxUnreadCount({ pending_events: 3, recovery_pending: false }),
		).toBe(3);
	});

	it("adds one for a pending recovery a member should notice", () => {
		expect(
			inboxUnreadCount({ pending_events: 0, recovery_pending: true }),
		).toBe(1);
		expect(
			inboxUnreadCount({ pending_events: 2, recovery_pending: true }),
		).toBe(3);
	});

	it("is zero when nothing awaits", () => {
		expect(
			inboxUnreadCount({ pending_events: 0, recovery_pending: false }),
		).toBe(0);
	});
});
