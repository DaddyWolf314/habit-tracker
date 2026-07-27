// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	listRuleChanges: vi.fn(() => Promise.resolve({ changes: [] })),
	ackRuleChanges: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { ackRuleChanges, listRuleChanges } from "#/lib/api.ts";
import type { RuleChangeNotice as Notice } from "#/shared/notifications.ts";
import { RuleChangeNotice } from "./rule-change-notice.tsx";

/**
 * The partner's notice that a rule changed (#64, #123). ADR 0002 gates rule
 * authoring to dom/switch and legitimises that with this notice — "transparency
 * standing in for a mutual-consent handshake, so dom-only authoring stays
 * consensual for the sub who is bound by rules they cannot author." It used to
 * live on the Rules screen, which #123 moved into Settings; a consent mechanism
 * cannot sit two taps deep behind a gear icon, so it renders on Today instead.
 */

function notice(partial: Partial<Notice> = {}): Notice {
	return {
		at: 1_700_000_000_000,
		kind: "edit",
		rule_id: "R8",
		...partial,
	} as Notice;
}

const listMock = vi.mocked(listRuleChanges);

describe("RuleChangeNotice", () => {
	beforeEach(() => {
		vi.mocked(ackRuleChanges).mockClear();
		listMock.mockReset();
		listMock.mockResolvedValue({ changes: [] });
	});
	afterEach(cleanup);

	it("renders nothing when no rule has changed", async () => {
		const { container } = render(<RuleChangeNotice />);
		await act(async () => {});

		expect(container.textContent).toBe("");
	});

	it("names each changed rule so the notice is not content-free", async () => {
		// The badge count is deliberately content-free (#42); this is the other
		// half — once you are inside the app, you are told what actually changed.
		listMock.mockResolvedValue({
			changes: [notice(), notice({ rule_id: "R9", kind: "disable" })],
		});
		render(<RuleChangeNotice />);
		await act(async () => {});

		expect(screen.getByText(/since you last looked/i)).not.toBeNull();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	it("acknowledges and clears when dismissed", async () => {
		listMock.mockResolvedValue({ changes: [notice()] });
		render(<RuleChangeNotice />);
		await act(async () => {});

		fireEvent.click(screen.getByRole("button", { name: /got it/i }));
		await act(async () => {});

		expect(ackRuleChanges).toHaveBeenCalled();
		expect(screen.queryByText(/since you last looked/i)).toBeNull();
	});

	it("keeps the notice up when the acknowledgement fails", async () => {
		// Losing the ack silently would be the wrong failure: better to show it
		// again than to mark a rule change seen that never reached the server.
		listMock.mockResolvedValue({ changes: [notice()] });
		vi.mocked(ackRuleChanges).mockRejectedValueOnce(new Error("offline"));
		render(<RuleChangeNotice />);
		await act(async () => {});

		fireEvent.click(screen.getByRole("button", { name: /got it/i }));
		await act(async () => {});

		expect(screen.getByText(/since you last looked/i)).not.toBeNull();
	});

	it("stays silent when the fetch fails", async () => {
		// Today is a glance surface; a rule-change fetch that fails must not put an
		// error where the countdowns go.
		listMock.mockRejectedValue(new Error("offline"));
		const { container } = render(<RuleChangeNotice />);
		await act(async () => {});

		expect(container.textContent).toBe("");
	});
});
