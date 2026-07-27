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
import type { VersionedAgreement } from "#/shared/agreements.ts";
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

function refType(
	id: string,
	key: string,
	label: string,
	opts: { minted?: boolean; extra?: EventType["metadata"] } = {},
): EventType {
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
				...(opts.minted ? { minted: true } : {}),
				set_permission: ["dom", "sub", "switch"],
			},
			...opts.extra,
		},
		awaiting: [],
		journaling: false,
	};
}

/** A journaling-capable type — the only kind that carries the visibility axis. */
function journalType(id: string): EventType {
	return {
		id,
		label: id,
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {},
		awaiting: [],
		journaling: true,
	};
}

/** A type whose ref cites the corpus rather than echoing a minted id. */
function citingType(
	id: string,
	key: string,
	label: string,
	agreementKind?: string,
): EventType {
	return {
		id,
		label: id,
		valence: "neutral",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {
			[key]: {
				kind: "ref",
				ref_kind: "agreement",
				...(agreementKind ? { agreement_kind: agreementKind } : {}),
				label,
				required: false,
				set_permission: ["dom", "sub", "switch"],
			},
		},
		awaiting: [],
		journaling: false,
	};
}

const TYPES: EventType[] = [
	citingType("infraction", "rule_ref", "Agreement"),
	citingType("ritual_completed", "ritual_id", "Ritual", "ritual"),
	journalType("journal_entry"),
	journalType("morning_pages"),
	refType("session_started", "session_id", "Session", { minted: true }),
	refType("session_ended", "session_id", "Session"),
	refType("task_assigned", "task_id", "Task", {
		minted: true,
		extra: {
			task_name: {
				kind: "text",
				max_length: 80,
				label: "Task name",
				required: true,
				set_permission: ["dom", "sub", "switch"],
			},
		},
	}),
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

const AGREEMENTS: VersionedAgreement[] = [
	{
		id: "ag_1",
		kind: "protocol",
		versions: [
			{
				effective_from: NOW - 1000,
				name: "ask before you come",
				text: "",
				retired: false,
			},
		],
	},
	{
		id: "ag_2",
		kind: "ritual",
		versions: [
			{
				effective_from: NOW - 1000,
				name: "morning kneel",
				text: "",
				retired: false,
			},
		],
	},
];

function composer(timers: TimerView[], onLogged: () => void) {
	return (
		<LogComposer
			types={TYPES}
			members={MEMBERS}
			openPrompts={[]}
			rules={RULES}
			timers={timers}
			agreements={AGREEMENTS}
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

	it("hides an originating ref on both types that mint one (ADR 0005)", () => {
		// An originating ref can have no candidates by construction — the event *is*
		// where the id comes from — so before minting it was a required free-text
		// field the author had to invent a value for. Now it is not user input at
		// all; the human label beside it is.
		for (const [type, name] of [
			["session_started", /session/i],
			["task_assigned", /^task$/i],
		] as const) {
			cleanup();
			renderComposer();
			chooseType(type);
			expect(screen.queryByRole("textbox", { name })).toBeNull();
			expect(screen.queryByRole("combobox", { name })).toBeNull();
		}
		expect(screen.getByRole("textbox", { name: /task name/i })).not.toBeNull();
	});

	it("logs a session_started with no hand-typed id", async () => {
		// The case #89 could not fix from the UI: the field was required, had no
		// candidates, and the id was invented by hand. The server mints it now, so
		// the event carries nothing at all here.
		const onLogged = vi.fn();
		renderComposer(onLogged);
		chooseType("session_started");

		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});

		expect(onLogged).toHaveBeenCalled();
		expect(logEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "session_started", metadata: {} }),
		);
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

/**
 * Visibility is chosen, never defaulted (#94, ADR 0001, CONTEXT §Visibility —
 * "the author *always* chooses explicitly; there is no silent default"). A
 * preselected control makes `shared` — the *most exposed* level — the outcome of
 * touching nothing, on the axis the design treats as an inviolable right. These
 * assert the choice is demanded and carried, never how the control is built.
 */
describe("LogComposer visibility", () => {
	// The mocked `logEvent` is one `vi.fn()` for the whole file, so its calls
	// accumulate across tests; these assert on *not* being called and need it
	// clean rather than merely restored.
	beforeEach(() => vi.mocked(logEvent).mockClear());
	afterEach(cleanup);

	/** The visibility select, present only on a journaling-capable type. */
	const picker = () => screen.getByRole("combobox", { name: /visibility/i });

	it("preselects nothing on a journaling type", () => {
		renderComposer();
		chooseType("journal_entry");

		expect(picker()).toHaveProperty("value", "");
	});

	it("refuses to log a journaling entry until visibility is chosen", async () => {
		renderComposer();
		chooseType("journal_entry");

		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});

		expect(logEvent).not.toHaveBeenCalled();
		expect(screen.getByText(/please fill in:.*visibility/i)).not.toBeNull();
	});

	it("logs the chosen visibility once it is set", async () => {
		const onLogged = vi.fn();
		renderComposer(onLogged);
		chooseType("journal_entry");

		fireEvent.change(picker(), { target: { value: "secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});

		expect(onLogged).toHaveBeenCalled();
		expect(logEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "journal_entry", visibility: "secret" }),
		);
	});

	it("does not carry a choice across a type switch", async () => {
		// Two journaling types in a row: the second must ask again rather than
		// inherit what the first was set to, or the choice stops being per-entry.
		renderComposer();
		chooseType("journal_entry");
		fireEvent.change(picker(), { target: { value: "secret" } });

		chooseType("morning_pages");

		expect(picker()).toHaveProperty("value", "");
		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});
		expect(logEvent).not.toHaveBeenCalled();
	});

	it("leaves a non-journaling type alone", async () => {
		// The gate is journaling capability, not the composer: an accountability
		// type has no choice to make and must not gain a blocking one.
		const onLogged = vi.fn();
		renderComposer(onLogged);
		chooseType("session_started");

		expect(screen.queryByRole("combobox", { name: /visibility/i })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});

		expect(onLogged).toHaveBeenCalled();
		expect(logEvent).toHaveBeenCalledWith(
			expect.objectContaining({ visibility: "shared" }),
		);
	});
});

/**
 * A citing ref in the composer (#121, ADR 0006). This is the failure #114 named,
 * finally closed: the couple's terms were free text on both sides of a rule's
 * equality, so one typo made the rule silently stop firing — the event logged
 * fine, the counter never moved, and the near-miss trace landed only on a
 * *matching* event, i.e. never.
 */
describe("LogComposer citing refs", () => {
	beforeEach(() => vi.mocked(logEvent).mockClear());
	afterEach(cleanup);

	it("offers the corpus instead of a free-text box", () => {
		renderComposer();
		chooseType("infraction");

		const picker = screen.getByRole("combobox", { name: /agreement/i });
		expect(
			[...picker.querySelectorAll("option")].map((o) => o.textContent),
		).toContain("ask before you come");
	});

	it("narrows to one kind where the field says so", () => {
		// Logging a completed ritual must not offer the couple's protocols.
		renderComposer();
		chooseType("ritual_completed");

		const labels = [
			...screen
				.getByRole("combobox", { name: /ritual/i })
				.querySelectorAll("option"),
		].map((o) => o.textContent);
		expect(labels).toContain("morning kneel");
		expect(labels).not.toContain("ask before you come");
	});

	it("submits the picked id, not a transcription of the name", async () => {
		const onLogged = vi.fn();
		renderComposer(onLogged);
		chooseType("infraction");

		fireEvent.change(screen.getByRole("combobox", { name: /agreement/i }), {
			target: { value: "ag_1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});

		expect(logEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "infraction",
				metadata: { rule_ref: "ag_1" },
			}),
		);
	});
});
