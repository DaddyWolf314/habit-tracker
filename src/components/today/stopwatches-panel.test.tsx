// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	logEvent: vi.fn(() => Promise.resolve({})),
}));

import { logEvent } from "#/lib/api.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
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

/** The two pack types this panel reads its vocabularies off (#182). */
const TYPES: EventType[] = [
	{
		id: "session_started",
		label: "Session started",
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: true,
		journaling: false,
		awaiting: [],
		metadata: {
			activity: {
				kind: "enum",
				options: ["kneeling", "service"],
				option_labels: { kneeling: "Kneeling", service: "Service" },
				label: "Activity",
				required: true,
				set_permission: ["dom", "sub", "switch"],
			},
		},
	},
	{
		id: "act",
		label: "Act",
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: true,
		journaling: false,
		awaiting: [],
		metadata: {
			act: {
				kind: "enum",
				options: ["impact", "oral"],
				option_labels: { impact: "Impact", oral: "Oral" },
				label: "Act",
				required: true,
				set_permission: ["dom", "sub", "switch"],
			},
			detail: {
				kind: "text",
				max_length: 80,
				label: "Detail",
				required: false,
				set_permission: ["dom", "sub", "switch"],
			},
			session_id: {
				kind: "ref",
				ref_kind: "session",
				label: "Session",
				required: false,
				set_permission: ["dom", "sub", "switch"],
			},
		},
	},
];

const MEMBERS: RoleMember[] = [
	{ member_id: "m1", role: "sub", is_self: true },
	{ member_id: "m2", role: "dom", is_self: false },
];

function event(over: Partial<EventView> = {}): EventView {
	return {
		id: "e1",
		type: "act",
		actor: "m1",
		subject: "m1",
		occurred_at: 1_700_000_060_000,
		logged_at: 1_700_000_060_000,
		metadata: {},
		composite_metadata: {},
		note: undefined,
		visibility: "shared",
		amendments: [],
		pending: false,
		retracted: false,
		...over,
	} as EventView;
}

function renderPanel(
	timers: TimerView[] = [stopwatch()],
	events: EventView[] = [],
) {
	render(
		<StopwatchesPanel
			timers={timers}
			types={TYPES}
			events={events}
			members={MEMBERS}
			selfId="m1"
			onChange={() => {}}
		/>,
	);
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

/**
 * Logging an act against a running session (#182). The reason this lives on the
 * session card at all is that `session_id` comes off the row — so the assertions
 * that matter are about what gets stamped without the author typing it.
 */
describe("logging an act on a running session", () => {
	beforeEach(() => {
		vi.mocked(logEvent).mockClear();
	});
	afterEach(cleanup);

	function openActForm() {
		renderPanel();
		fireEvent.click(screen.getByRole("button", { name: "+ Log an act" }));
	}

	it("stamps the row's own session_id, which the author never types", async () => {
		openActForm();
		fireEvent.change(screen.getByLabelText("Act"), {
			target: { value: "impact" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Log act" }));
		await act(async () => {});

		expect(vi.mocked(logEvent)).toHaveBeenCalledWith({
			type: "act",
			subject: "m1",
			metadata: { act: "impact", session_id: "01JB6X" },
		});
	});

	it("omits an empty detail rather than sending a blank", async () => {
		openActForm();
		fireEvent.change(screen.getByLabelText("Act"), {
			target: { value: "oral" },
		});
		fireEvent.change(screen.getByLabelText("Detail (optional)"), {
			target: { value: "  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Log act" }));
		await act(async () => {});

		expect(vi.mocked(logEvent)).toHaveBeenCalledWith({
			type: "act",
			subject: "m1",
			metadata: { act: "oral", session_id: "01JB6X" },
		});
	});

	it("records the recipient the author picked, not the session's subject", async () => {
		// `subject` is the act's recipient. A session about the sub can still
		// contain an act the dom received, so the default must be overridable —
		// pinning it would quietly record the wrong person.
		openActForm();
		fireEvent.change(screen.getByLabelText("Act"), {
			target: { value: "oral" },
		});
		fireEvent.change(screen.getByLabelText("About"), {
			target: { value: "m2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Log act" }));
		await act(async () => {});

		expect(vi.mocked(logEvent)).toHaveBeenCalledWith({
			type: "act",
			subject: "m2",
			metadata: { act: "oral", session_id: "01JB6X" },
		});
	});

	it("will not log until an act is actually chosen", () => {
		// No preselection: these options are not interchangeable, and a mis-tap on
		// a preselected one would record something that did not happen.
		openActForm();
		expect(
			screen.getByRole("button", { name: "Log act" }).hasAttribute("disabled"),
		).toBe(true);
	});
});

describe("what a running session shows", () => {
	afterEach(cleanup);

	it("lists what was logged against it, by the pack's own copy", () => {
		renderPanel(
			[stopwatch()],
			[
				event({
					id: "e1",
					composite_metadata: { act: "impact", session_id: "01JB6X" },
				}),
			],
		);
		expect(screen.getByText(/Impact/)).toBeTruthy();
	});

	it("shows an orgasm logged against the session, not only acts", () => {
		// `orgasm` and `edge` gained `session_id` in the same change. The contents
		// read the metadata rather than a type allowlist, so they appear without
		// this panel naming them.
		renderPanel(
			[stopwatch()],
			[
				event({
					id: "e2",
					type: "orgasm",
					composite_metadata: { session_id: "01JB6X" },
				}),
			],
		);
		expect(screen.getByText("orgasm")).toBeTruthy();
	});

	it("leaves out the events that bound the session and anything withdrawn", () => {
		renderPanel(
			[stopwatch()],
			[
				event({
					id: "e3",
					type: "session_started",
					composite_metadata: { activity: "service", session_id: "01JB6X" },
				}),
				event({
					id: "e4",
					retracted: true,
					composite_metadata: { act: "impact", session_id: "01JB6X" },
				}),
			],
		);
		expect(screen.queryByText(/Impact/)).toBeNull();
		expect(screen.queryByText(/Session started/)).toBeNull();
	});

	it("leaves out an act belonging to a different session", () => {
		renderPanel(
			[stopwatch()],
			[
				event({
					id: "e5",
					composite_metadata: { act: "impact", session_id: "other" },
				}),
			],
		);
		expect(screen.queryByText(/Impact/)).toBeNull();
	});

	it("labels the activity from the pack, not a local copy", () => {
		// `ACTIVITY_OPTIONS` used to be hardcoded here, which meant the pack's own
		// `option_labels` were ignored and a couple-added activity could not appear.
		renderPanel([stopwatch({ tag: "kneeling" })]);
		// Scoped to the running row: the start form's select offers the same word,
		// which is the point — both now read the same source.
		const [row] = screen.getAllByRole("listitem");
		expect(within(row).getByText("Kneeling")).toBeTruthy();
	});
});
