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
	amendEvent: vi.fn(() => Promise.resolve({})),
}));

import { amendEvent } from "#/lib/api.ts";
import type { ConversationFlagView } from "#/shared/conversations.ts";
import { ConversationFlagsPanel } from "./conversation-flags-panel.tsx";

/**
 * R18's surface (#88, ADR 0007). The property worth protecting is that replying
 * is a **recorded act**, not a dismissal: the button writes a `response`
 * amendment against the check-in, and closing the flag is a consequence of that
 * rather than the point of it. A panel that cleared the flag any other way would
 * still look right on screen while losing the record of whether they ever talked.
 */

const flag = (
	over: Partial<ConversationFlagView> = {},
): ConversationFlagView => ({
	event_id: "e1",
	actor: "sub-1",
	occurred_at: Date.now(),
	note: "rough week",
	mood: 2,
	...over,
});

describe("ConversationFlagsPanel", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(cleanup);

	it("renders nothing when no one is asking to talk", () => {
		const { container } = render(
			<ConversationFlagsPanel flags={[]} selfId="dom-1" onChange={() => {}} />,
		);
		expect(container.textContent).toBe("");
	});

	it("shows the partner's ask with what they wrote", () => {
		render(
			<ConversationFlagsPanel
				flags={[flag()]}
				selfId="dom-1"
				onChange={() => {}}
			/>,
		);
		expect(screen.getByText("Your partner asked to talk")).not.toBeNull();
		expect(screen.getByText("rough week")).not.toBeNull();
	});

	it("offers the author no way to clear their own ask", () => {
		// There is nothing to dismiss — the other person answering is the ending.
		render(
			<ConversationFlagsPanel
				flags={[flag()]}
				selfId="sub-1"
				onChange={() => {}}
			/>,
		);
		expect(screen.getByText("You asked to talk")).not.toBeNull();
		expect(screen.getByText("Waiting for a reply")).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
	});

	it("closes the flag by writing a response amendment", async () => {
		const onChange = vi.fn();
		render(
			<ConversationFlagsPanel
				flags={[flag()]}
				selfId="dom-1"
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		fireEvent.change(screen.getByPlaceholderText("Say something back."), {
			target: { value: "  tonight, after dinner  " },
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		});
		expect(amendEvent).toHaveBeenCalledWith({
			kind: "response",
			target_event_id: "e1",
			note: "tonight, after dinner",
		});
		expect(onChange).toHaveBeenCalled();
	});

	it("refuses an empty reply — a response is prose, not an acknowledgement", async () => {
		render(
			<ConversationFlagsPanel
				flags={[flag()]}
				selfId="dom-1"
				onChange={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		});
		expect(amendEvent).not.toHaveBeenCalled();
		expect(screen.getByText("Write something back.")).not.toBeNull();
	});

	it("says how long an old ask has been standing", () => {
		// It never expires, so how long it has waited is the only urgency there is.
		const days = 3;
		render(
			<ConversationFlagsPanel
				flags={[flag({ occurred_at: Date.now() - days * 86_400_000 })]}
				selfId="dom-1"
				onChange={() => {}}
			/>,
		);
		expect(screen.getByText(/Asked 3 days ago/)).not.toBeNull();
	});
});
