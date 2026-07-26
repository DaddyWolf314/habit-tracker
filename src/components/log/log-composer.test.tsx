// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({ logEvent: vi.fn(() => Promise.resolve({})) }));

import { logEvent } from "#/lib/api.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { Rule } from "#/shared/rules.ts";
import type { TimerView } from "#/shared/timers.ts";
import { LogComposer } from "./log-composer.tsx";

/**
 * Ref fields in the composer (#89). Rules match refs by strict equality, so a
 * hand-typed `session_id`/`task_id` that is one character off logs fine and then
 * closes nothing — the countdown runs to `expired` and the near-miss trace lands
 * on the matching event, i.e. never. These cover the states of the fix: an
 * echoing ref becomes a picker, an originating ref stays free text, and the
 * escape keeps an off-list id loggable.
 */

const NOW = 1_700_000_000_000;

const MEMBERS: RoleMember[] = [
	{ member_id: "m1", role: "sub", is_self: true },
	{ member_id: "m2", role: "dom", is_self: false },
];

function refType(id: string, key: string, label: string): EventType {
	return {
		id,
		label: id,
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {
			[key]: {
				kind: "ref",
				ref_kind: key.replace(/_id$/, ""),
				label,
				required: true,
				set_permission: ["dom", "sub", "switch"],
			},
		},
		awaiting: [],
		journaling: false,
	};
}

const TYPES: EventType[] = [
	refType("session_started", "session_id", "Session"),
	refType("session_ended", "session_id", "Session"),
];

const RULES: Rule[] = [
	{
		id: "R15",
		enabled: true,
		condition: { type: "session_started", metadata: {} },
		effects: [
			{
				verb: "open_timer",
				timer: "session_stopwatch",
				match_on: { session_id: "session_id" },
				tag_from: "activity",
			},
		],
	},
	{
		id: "R16",
		enabled: true,
		condition: { type: "session_ended", metadata: {} },
		effects: [
			{
				verb: "close_timer",
				timer: "session_stopwatch",
				match_on: { session_id: "session_id" },
				status: "completed",
			},
		],
	},
];

function stopwatch(id: string, sessionId: string): TimerView {
	return {
		id,
		kind: "stopwatch",
		timer: "session_stopwatch",
		tag: "kneeling",
		match: { session_id: sessionId },
		opened_at: NOW - 60_000,
		closed_at: null,
		status: null,
		duration_ms: null,
		deadline_at: null,
		paused_at: null,
		remaining_ms: null,
	};
}

const TIMERS: TimerView[] = [stopwatch("t1", "sess-1")];

function composer(timers: TimerView[], onLogged: () => void) {
	return (
		<LogComposer
			types={TYPES}
			members={MEMBERS}
			openPrompts={[]}
			rules={RULES}
			timers={timers}
			onLogged={onLogged}
		/>
	);
}

function renderComposer(onLogged = () => {}) {
	return render(composer(TIMERS, onLogged));
}

/** Picks an event type, which is what reveals the metadata form. */
function chooseType(id: string) {
	fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
		target: { value: id },
	});
}

describe("LogComposer ref fields", () => {
	// The option labels carry how long each timer has run, so the clock has to
	// stand still for them to be assertable.
	beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("offers the running stopwatches when the ref closes one", () => {
		renderComposer();
		chooseType("session_ended");

		const picker = screen.getByRole("combobox", { name: /session/i });
		expect(
			[...picker.querySelectorAll("option")].map((o) => o.textContent),
		).toContain("kneeling — 1m 0s");
	});

	it("submits the picked id, not a transcription of it", async () => {
		const onLogged = vi.fn();
		renderComposer(onLogged);
		chooseType("session_ended");

		fireEvent.change(screen.getByRole("combobox", { name: /session/i }), {
			target: { value: "sess-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});

		expect(onLogged).toHaveBeenCalled();
		expect(logEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "session_ended",
				metadata: { session_id: "sess-1" },
			}),
		);
	});

	it("keeps free text for an originating ref", () => {
		// `session_started` opens the stopwatch — it originates the id, and
		// offering a running one would double-open the same session.
		renderComposer();
		chooseType("session_started");

		expect(screen.getByRole("textbox", { name: /session/i })).not.toBeNull();
		expect(screen.queryByRole("combobox", { name: /session/i })).toBeNull();
	});

	it("keeps a picked id visible after its timer stops being offered", () => {
		// The log polls under the open sheet, so the partner can close the very
		// stopwatch someone already picked. The select must not silently read
		// blank while the form still holds that id.
		const { rerender } = renderComposer();
		chooseType("session_ended");
		fireEvent.change(screen.getByRole("combobox", { name: /session/i }), {
			target: { value: "sess-1" },
		});

		rerender(composer([stopwatch("t2", "sess-2")], () => {}));

		expect(
			screen.getByRole("option", {
				name: "sess-1 — no longer offered",
				selected: true,
			}),
		).not.toBeNull();
	});

	it("falls back to free text through the escape", () => {
		// A task completed long after its countdown expired has no candidate left;
		// the author must still be able to name it.
		renderComposer();
		chooseType("session_ended");

		fireEvent.click(
			screen.getByRole("button", { name: "Type an id in instead" }),
		);

		const input = screen.getByRole("textbox", { name: /session/i });
		fireEvent.change(input, { target: { value: "sess-off-list" } });
		fireEvent.click(screen.getByRole("button", { name: "Log it" }));

		expect(logEvent).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: { session_id: "sess-off-list" } }),
		);
	});
});
