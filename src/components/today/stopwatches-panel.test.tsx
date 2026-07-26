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
 * Stop is deliberately one tap, and stays that way (#93).
 *
 * It is irreversible in the sense the house two-tap guard exists for — a
 * stopwatch cannot reopen, so restarting mints a fresh `session_id` and the
 * clock begins again at zero. It is still not guarded: stopping is what the
 * control is *for*, the same way Mark done is, and the event log keeps the
 * record either way. A second tap here would put friction on the daily loop to
 * protect a mis-tap that costs only the running clock.
 *
 * This test exists because that is exactly the kind of inconsistency a later
 * consistency pass would quietly "fix".
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

describe("stopping a session", () => {
	beforeEach(() => {
		vi.mocked(logEvent).mockClear();
	});
	afterEach(cleanup);

	it("stops on a single tap, echoing the row's own refs", async () => {
		renderPanel();
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await act(async () => {});
		expect(vi.mocked(logEvent)).toHaveBeenCalledWith({
			type: "session_ended",
			subject: "m1",
			metadata: { session_id: "01JB6X", activity: "service" },
		});
	});

	it("asks for no confirmation — ending a session is the control's purpose", () => {
		renderPanel();
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(screen.queryByRole("button", { name: /^Yes,/ })).toBeNull();
	});

	it("hides Stop on a row it could not actually close", () => {
		// Without a pinned `session_id` the close would have nothing to pair on,
		// so the tap would silently no-op rather than end anything.
		renderPanel([stopwatch({ match: {} })]);
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
	});
});
