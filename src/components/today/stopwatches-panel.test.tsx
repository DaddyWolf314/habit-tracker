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
	logEvent: vi.fn(() => Promise.resolve({})),
}));

import { logEvent } from "#/lib/api.ts";
import type { TimerView } from "#/shared/timers.ts";
import { StopwatchesPanel } from "./stopwatches-panel.tsx";

/**
 * Stopping a session can't be undone — restarting mints a fresh `session_id`
 * and the elapsed time begins again at zero — so it takes the house two-tap
 * inline confirm (#93). The event log keeps the record either way; what a
 * mis-tap costs is the running clock.
 */

function stopwatch(over: Partial<TimerView> = {}): TimerView {
	return {
		id: "t1",
		kind: "stopwatch",
		timer: "session_stopwatch",
		tag: "service",
		match: { session_id: "01JB6X" },
		opened_at: 1_700_000_000_000,
		closed_at: null,
		status: null,
		duration_ms: null,
		deadline_at: null,
		paused_at: null,
		remaining_ms: null,
		...over,
	};
}

function renderPanel(timers: TimerView[] = [stopwatch()]) {
	render(<StopwatchesPanel timers={timers} selfId="m1" onChange={() => {}} />);
}

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

describe("stopping a session", () => {
	beforeEach(() => {
		vi.mocked(logEvent).mockClear();
	});
	afterEach(cleanup);

	it("does not stop on the first tap", () => {
		renderPanel();
		click("Stop");
		expect(vi.mocked(logEvent)).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Yes, stop" })).not.toBeNull();
	});

	it("stops on the second tap, echoing the row's own refs", async () => {
		renderPanel();
		click("Stop");
		click("Yes, stop");
		await act(async () => {});
		expect(vi.mocked(logEvent)).toHaveBeenCalledWith({
			type: "session_ended",
			subject: "m1",
			metadata: { session_id: "01JB6X", activity: "service" },
		});
	});

	it("backing out drops the confirm without stopping", () => {
		renderPanel();
		click("Stop");
		click("Keep going");
		expect(vi.mocked(logEvent)).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Yes, stop" })).toBeNull();
		expect(screen.getByRole("button", { name: "Stop" })).not.toBeNull();
	});

	it("arms only the row that was tapped", () => {
		renderPanel([
			stopwatch(),
			stopwatch({ id: "t2", match: { session_id: "01JB6Y" } }),
		]);
		fireEvent.click(screen.getAllByRole("button", { name: "Stop" })[0]);
		expect(screen.getAllByRole("button", { name: "Yes, stop" })).toHaveLength(
			1,
		);
		expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
	});
});
