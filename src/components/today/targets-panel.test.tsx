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
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { Rule } from "#/shared/rules.ts";
import { TargetsPanel } from "./targets-panel.tsx";

/**
 * The targets panel (#135). Two properties carry the weight and both are about
 * recording the right thing rather than the convenient thing: a streak never
 * gets a row of its own (CONTEXT §Target counter — it is "a property of one"),
 * and a tick logs the **event**, never the counter.
 */

function counter(partial: Partial<Counter> & Pick<Counter, "id">): Counter {
	return {
		name: partial.id,
		valence: "neutral",
		target_direction: "floor",
		reset: "never",
		rungs: [],
		modify_permission: ["dom", "sub", "switch"],
		value: 0,
		updated_at: null,
		...partial,
	};
}

const KNEEL = counter({
	id: "ag_7f3_today",
	name: "Morning kneel",
	daily_target: 1,
	reset: "daily",
});
const KNEEL_STREAK = counter({
	id: "ag_7f3_streak",
	name: "Morning kneel streak",
	value: 12,
	streak: { counter: "ag_7f3_today", period: "daily" },
});
const KNEEL_RULE: Rule = {
	id: "r",
	enabled: true,
	condition: { type: "ritual_completed", metadata: { ritual_id: "ag_7f3" } },
	effects: [{ verb: "increment_counter", counter: "ag_7f3_today", by: 1 }],
};

/**
 * The term the rule above cites, renamed since the counter was scaffolded — the
 * case that makes the row's provenance line carry information rather than repeat
 * the counter's own name (#212 item 5).
 */
const TERM: VersionedAgreement = {
	id: "ag_7f3",
	kind: "ritual",
	versions: [
		{ effective_from: 0, name: "Dawn kneel", text: "", retired: false },
	],
};

const TYPES: EventType[] = [
	{
		id: "ritual_completed",
		label: "Ritual completed",
		valence: "positive",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {
			ritual_id: {
				kind: "ref",
				ref_kind: "agreement",
				agreement_kind: "ritual",
				label: "Ritual",
				required: false,
				set_permission: ["dom", "sub", "switch"],
			},
		},
		awaiting: [],
		journaling: false,
	},
];

function renderPanel(
	counters: Counter[],
	rules: Rule[] = [],
	onChange = () => {},
) {
	return render(
		<TargetsPanel
			counters={counters}
			rules={rules}
			types={TYPES}
			onChange={onChange}
		/>,
	);
}

describe("TargetsPanel", () => {
	beforeEach(() => vi.mocked(logEvent).mockClear());
	afterEach(cleanup);

	it("renders nothing when no counter carries a target", () => {
		// Not an empty state: a couple with no targets has nothing to be shown, and
		// a card saying so would be noise on the glance screen.
		const { container } = renderPanel([
			counter({ id: "demerits", name: "Demerits", value: 2 }),
		]);
		expect(container.textContent).toBe("");
	});

	it("shows progress against the target", () => {
		renderPanel([{ ...KNEEL, value: 0 }]);
		expect(screen.getByText("Morning kneel")).not.toBeNull();
		expect(screen.getByText(/0 \/ 1/)).not.toBeNull();
	});

	it("shows the streak inside the row, not as a row of its own", () => {
		renderPanel([KNEEL, KNEEL_STREAK]);
		expect(screen.getByText(/12-day streak/)).not.toBeNull();
		// The streak counter's own name never appears — it is a property, not an
		// entry, and rendering it as one would contradict the model on screen.
		expect(screen.queryByText("Morning kneel streak")).toBeNull();
	});

	it("marks a weekly target for its period", () => {
		renderPanel([
			counter({
				id: "check_ins_week",
				name: "Check-ins",
				weekly_target: 3,
				reset: "weekly",
			}),
		]);
		expect(screen.getByText(/this week/i)).not.toBeNull();
	});

	it("logs the event, not the counter", async () => {
		// The whole point of the affordance. A `+1` here would append
		// counter_adjusted — "the number went up" rather than "I did the morning
		// kneel" — firing no rule and citing no term, while the streak still moved.
		const onChange = vi.fn();
		renderPanel([KNEEL], [KNEEL_RULE], onChange);

		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});

		expect(logEvent).toHaveBeenCalledWith({
			type: "ritual_completed",
			metadata: { ritual_id: "ag_7f3" },
		});
		expect(onChange).toHaveBeenCalled();
	});

	it("offers no tick when no rule says what the counter counts", () => {
		// A hand-made target counter. Better a readout than a button that records
		// the wrong act.
		renderPanel([KNEEL], []);
		expect(screen.queryByRole("button", { name: "Log it" })).toBeNull();
		expect(screen.getByText("Morning kneel")).not.toBeNull();
	});

	it("is not headed with the page's own title", () => {
		// It was headed "Today", inside the page titled Today (#212 item 2) — two
		// headings deep in one word, on the panel a new couple meets first.
		renderPanel([KNEEL], [KNEEL_RULE]);
		expect(
			screen.getByRole("heading", { name: "What you're aiming at" }),
		).not.toBeNull();
		expect(screen.queryByRole("heading", { name: "Today" })).toBeNull();
	});

	it("says which term a scaffolded row counts", () => {
		// "Track this" makes three artifacts and explains them once, at creation
		// (#212 item 5). ADR 0006 stores no link, so this is read back out of the
		// citation on the rule — the record that tracking happened.
		render(
			<TargetsPanel
				counters={[KNEEL]}
				rules={[KNEEL_RULE]}
				types={TYPES}
				agreements={[TERM]}
				onChange={() => {}}
			/>,
		);
		expect(
			screen.getByText(/Counts “Dawn kneel” from your agreements/),
		).not.toBeNull();
	});

	it("says nothing about a term for the pack's seeded row", () => {
		// R1 increments unconditionally and cites nothing, so the row did not come
		// from anything the couple agreed — claiming otherwise would be inventing a
		// provenance.
		renderPanel([KNEEL], []);
		expect(screen.queryByText(/from your agreements/)).toBeNull();
	});

	it("says why a row has no button", () => {
		// The seeded case (#212, #214): the pack's counter is incremented by an
		// unconditional rule, so `tickFor` has nothing to cite and the row is a
		// readout — which #214's floor only explains while the log is empty.
		renderPanel([KNEEL], []);
		fireEvent.click(screen.getByRole("button", { name: "What is this?" }));
		expect(screen.getByText(/“Morning kneel” has no button/)).not.toBeNull();
	});

	it("says the rows are ticked once they can be", () => {
		renderPanel([KNEEL], [KNEEL_RULE]);
		fireEvent.click(screen.getByRole("button", { name: "What is this?" }));
		expect(screen.getByText(/Every row here has a button/)).not.toBeNull();
	});

	it("keeps the row when logging fails, and says so", async () => {
		vi.mocked(logEvent).mockRejectedValueOnce(new Error("offline"));
		renderPanel([KNEEL], [KNEEL_RULE]);

		fireEvent.click(screen.getByRole("button", { name: "Log it" }));
		await act(async () => {});

		expect(screen.getByText(/offline/i)).not.toBeNull();
		expect(screen.getByRole("button", { name: "Log it" })).not.toBeNull();
	});
});
