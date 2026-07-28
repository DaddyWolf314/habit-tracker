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

import { cancelTimer, logEvent, pauseTimer } from "#/lib/api.ts";
import type { Role } from "#/shared/roles.ts";
import type { TimerView } from "#/shared/timers.ts";
import { STARTER_EVENT_TYPES } from "#/templates/index.ts";
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

/** `sub` is the only role that gets Mark done — the dom keeps the live controls. */
function renderPanel(
	timers: TimerView[] = [countdown()],
	selfRole: Role = "dom",
) {
	render(
		<CountdownsPanel
			timers={timers}
			selfRole={selfRole}
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

/**
 * A closed countdown used to print its terminal disposition verbatim — "expired",
 * "canceled" (#149). `timerViewSchema.status` is an open string, so the copy is a
 * lookup with a de-slugging fallback: a disposition added later degrades to
 * readable rather than raw.
 */
describe("closed countdown dispositions", () => {
	afterEach(cleanup);

	const closed = (status: string) =>
		countdown({ status, closed_at: 1_700_000_100_000 });

	it("reads an expired countdown as overdue, like the prompt picker", () => {
		renderPanel([closed("expired")]);
		expect(screen.getByText("overdue")).toBeDefined();
		expect(screen.queryByText("expired")).toBeNull();
	});

	// "auto-closed" is what the sessions panel and the trace ledger have always
	// called it; a third phrasing here would be two names for one thing.
	it("says auto-closed the way every other surface does", () => {
		renderPanel([closed("auto_closed")]);
		expect(screen.getByText("auto-closed")).toBeDefined();
		expect(screen.queryByText("auto_closed")).toBeNull();
	});

	// These three coincide with their stored value — they were already the right
	// word — but they go through the map, so a rename can't leak to the page.
	it("keeps the plain dispositions plain", () => {
		for (const status of ["canceled", "completed", "failed"] as const) {
			cleanup();
			renderPanel([closed(status)]);
			expect(screen.getByText(status)).toBeDefined();
		}
	});

	it("de-slugs a disposition it has never seen", () => {
		renderPanel([closed("superseded_by_replacement")]);
		expect(screen.getByText("superseded by replacement")).toBeDefined();
	});
});

/**
 * `overdue` is the one word for a passed deadline on every surface (CONTEXT.md;
 * `ref-candidates.ts`), so the live row can't say "due" while the closed row
 * below it says something else.
 */
describe("an active countdown past its deadline", () => {
	afterEach(cleanup);

	it("reads overdue", () => {
		renderPanel([
			countdown({
				opened_at: 1,
				deadline_at: 2,
				remaining_ms: 0,
			}),
		]);
		expect(screen.getByText("overdue")).toBeDefined();
		expect(screen.queryByText("due")).toBeNull();
	});
});

/**
 * The sub's quality picker (#154). Two defects, one form: the qualities printed
 * as their stored values, and the blank option called the dom's ruling a "grade"
 * — a word `CONTEXT.md`'s Adjudication entry explicitly avoids.
 *
 * The copy is claim-shaped because the sub is the one speaking here: they report
 * how they think they did, and the dom rules on it afterwards. The queue and the
 * generic composer still print the stored token through their shared enum
 * control, which is a known gap rather than a decision — see the map's docstring.
 */
describe("the sub's quality picker", () => {
	beforeEach(() => vi.mocked(logEvent).mockClear());
	afterEach(cleanup);

	// Opening the form replaces the row's Mark done with the form's submit, so
	// there is only ever one button by that name.
	const openMarkDone = () => {
		renderPanel([countdown()], "sub");
		click("Mark done");
	};

	const options = () => screen.getAllByRole("option") as HTMLOptionElement[];

	it("offers a claim rather than a stored value", () => {
		openMarkDone();
		for (const [value, label] of [
			["exceeded", "Went beyond what was asked"],
			["met", "Did what was asked"],
			["partial", "Got part of the way"],
		] as const) {
			const option = screen.getByRole("option", {
				name: label,
			}) as HTMLOptionElement;
			// Pin the pairing, not just the presence — swapping two labels has to
			// fail, since a claim attached to the wrong value is worse than a raw one.
			expect(option.value).toBe(value);
			expect(screen.queryByRole("option", { name: value })).toBeNull();
		}
	});

	// The map is hand-written; the pack is the authority. If someone adds a fourth
	// quality to `event-types.json`, the exhaustive (fallback-free) map has to fail
	// here rather than silently drop the option from the sub's picker.
	it("offers exactly the qualities the pack defines", () => {
		openMarkDone();
		const field = STARTER_EVENT_TYPES.find((t) => t.id === "task_completed")
			?.metadata.quality;
		const packOptions = field?.kind === "enum" ? field.options : undefined;
		expect(packOptions).toBeDefined();
		expect(
			options()
				.map((o) => o.value)
				.filter(Boolean),
		).toEqual(packOptions);
	});

	it("calls the dom's ruling a ruling", () => {
		openMarkDone();
		expect(screen.queryByText(/grade/i)).toBeNull();
		expect(
			screen.getByRole("option", { name: /leave it for your dom to rule on/i }),
		).toBeDefined();
	});

	// The copy is display-layer: what crosses the wire is still the pack's enum.
	it("logs the stored value the pack defines, not the copy", async () => {
		openMarkDone();
		fireEvent.change(screen.getByLabelText(/quality/i), {
			target: { value: "exceeded" },
		});
		click("Mark done");
		await act(async () => {});
		expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "task_completed",
				metadata: { task_id: "01JB6X", quality: "exceeded" },
			}),
		);
	});

	// Leaving it blank is the whole point of the field being optional: the
	// completion lands pending the dom's ruling rather than self-assigning one.
	it("sends no quality at all when left blank", async () => {
		openMarkDone();
		click("Mark done");
		await act(async () => {});
		expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: { task_id: "01JB6X" } }),
		);
	});
});
