import { describe, expect, it } from "vitest";
import { unreadCount } from "./notifications.ts";

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
