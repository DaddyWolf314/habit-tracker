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
	cancelTimer: vi.fn(() => Promise.resolve({})),
	extendTimer: vi.fn(() => Promise.resolve({})),
	logEvent: vi.fn(() => Promise.resolve({})),
	pauseTimer: vi.fn(() => Promise.resolve({})),
	resumeTimer: vi.fn(() => Promise.resolve({})),
}));

import { cancelTimer, pauseTimer } from "#/lib/api.ts";
import type { TimerView } from "#/shared/timers.ts";
import { CountdownsPanel } from "./countdowns-panel.tsx";

/**
 * Cancelling a countdown writes the terminal `canceled` disposition and there is
 * no reopen — the sub's live deadline ends, and a replacement loses the elapsed
 * time and its link to the assigning event. It sits in the same button row as
 * the reversible Pause and +extend controls, so it takes the house two-tap
 * inline confirm (#93).
 */

function countdown(over: Partial<TimerView> = {}): TimerView {
	return {
		id: "t1",
		kind: "countdown",
		timer: "task_countdown",
		tag: "dishes",
		match: { task_id: "01JB6X" },
		opened_at: 1_700_000_000_000,
		closed_at: null,
		status: null,
		duration_ms: 3_600_000,
		deadline_at: 1_700_000_000_000 + 3_600_000,
		paused_at: null,
		remaining_ms: 3_600_000,
		...over,
	};
}

function renderPanel(timers: TimerView[] = [countdown()]) {
	render(
		<CountdownsPanel
			timers={timers}
			selfRole="dom"
			selfId="m1"
			partnerId="m2"
			onChange={() => {}}
		/>,
	);
}

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

describe("cancelling a countdown", () => {
	beforeEach(() => {
		vi.mocked(cancelTimer).mockClear();
		vi.mocked(pauseTimer).mockClear();
	});
	afterEach(cleanup);

	it("does not cancel on the first tap", () => {
		renderPanel();
		click("Cancel");
		expect(vi.mocked(cancelTimer)).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Yes, cancel it" }),
		).not.toBeNull();
	});

	it("cancels on the second tap", async () => {
		renderPanel();
		click("Cancel");
		click("Yes, cancel it");
		await act(async () => {});
		expect(vi.mocked(cancelTimer)).toHaveBeenCalledWith("t1");
	});

	it("backing out drops the confirm without cancelling", () => {
		renderPanel();
		click("Cancel");
		// The negative names what you keep — "Cancel" would mean both things here.
		click("Keep it running");
		expect(vi.mocked(cancelTimer)).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Yes, cancel it" })).toBeNull();
		expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
	});

	it("arms only the row that was tapped", () => {
		renderPanel([countdown(), countdown({ id: "t2" })]);
		fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
		expect(
			screen.getAllByRole("button", { name: "Yes, cancel it" }),
		).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
	});

	it("leaves the reversible controls one tap", async () => {
		renderPanel();
		click("Pause");
		await act(async () => {});
		expect(vi.mocked(pauseTimer)).toHaveBeenCalledWith("t1");
	});
});
