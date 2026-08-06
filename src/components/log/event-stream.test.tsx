// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	ackUpdates: vi.fn(() => Promise.resolve({ ok: true })),
	amendEvent: vi.fn(() => Promise.resolve({})),
	getEventTrace: vi.fn(() => Promise.resolve({ rows: [] })),
}));

import { ackUpdates, amendEvent } from "#/lib/api.ts";
import type { VersionedAgreement } from "#/shared/agreements.ts";
import type { Amendment } from "#/shared/amendments.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { STARTER_EVENT_TYPES } from "#/templates/index.ts";
import { EventStream } from "./event-stream.tsx";

/**
 * What the event card shows of an event's metadata (ADR 0005). A minted ref is
 * machine identity: the reader learns nothing from `01JB6X…` and can act on none
 * of it, and the composer already refuses to render the same field on the way in.
 * The export is what keeps it auditable (see `export.test.ts`).
 */

const MEMBERS: RoleMember[] = [
	{ member_id: "m1", role: "dom", is_self: true },
	{ member_id: "m2", role: "sub", is_self: false },
];

const TYPES: EventType[] = [...STARTER_EVENT_TYPES];

function event(over: Partial<EventView> & Pick<EventView, "type">): EventView {
	return {
		id: "evt-1",
		actor: "m1",
		occurred_at: 1_700_000_000_000,
		logged_at: 1_700_000_000_000,
		metadata: {},
		visibility: "shared",
		composite_metadata: {},
		amendments: [],
		pending: false,
		retracted: false,
		...over,
	};
}

function renderStream(
	events: EventView[],
	agreements: VersionedAgreement[] = [],
) {
	return render(
		<EventStream
			events={events}
			types={TYPES}
			members={MEMBERS}
			agreements={agreements}
			selfId="m1"
		/>,
	);
}

describe("minted refs on the event card", () => {
	afterEach(cleanup);

	it("shows the floor of a journal prompt but not its prompt_id", () => {
		renderStream([
			event({
				type: "journal_prompt",
				composite_metadata: { prompt_id: "01JB6X", floor: "sealed" },
			}),
		]);
		// The floor reads as its option label, not the stored token (#155) — the
		// same word the control that set it offered.
		expect(screen.getByText("Minimum visibility: Sealed")).not.toBeNull();
		expect(screen.queryByText(/prompt_id/)).toBeNull();
		expect(screen.queryByText(/01JB6X/)).toBeNull();
	});

	it("shows a task's name but not the id minted for it", () => {
		renderStream([
			event({
				type: "task_assigned",
				composite_metadata: {
					task_id: "01JB6X",
					task_name: "dishes",
					duration_ms: 60_000,
				},
			}),
		]);
		expect(screen.getByText("Task: dishes")).not.toBeNull();
		// The minted id itself stays out — asserted on the value, since the key is
		// no longer rendered for any field.
		expect(screen.queryByText(/01JB6X/)).toBeNull();
	});

	it("keeps an echoing ref — that id is the one the author chose", () => {
		// `task_completed` names an existing countdown; the value is the author's
		// pick and the pairing is the point, so hiding it would hide the act.
		renderStream([
			event({
				type: "task_completed",
				composite_metadata: { task_id: "01JB6X", quality: "met" },
			}),
		]);
		expect(screen.getByText("Task: 01JB6X")).not.toBeNull();
	});

	it("hides nothing for a type the couple no longer has", () => {
		renderStream([
			event({ type: "gone", composite_metadata: { prompt_id: "01JB6X" } }),
		]);
		// No schema means no label, so the raw key stands in — better an unlabelled
		// value than a dropped one.
		expect(screen.getByText("prompt_id: 01JB6X")).not.toBeNull();
	});
});

/**
 * Retracting your own pending event takes the house two-tap inline confirm
 * (#93) — a browser dialog would block the whole surface. These pin the
 * behaviour the shared `InlineConfirm` has to preserve.
 */
describe("retracting your own pending event", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(amendEvent).mockClear();
	});

	const ownPending = () =>
		renderStream([event({ type: "task_completed", pending: true })]);
	const click = (name: string) =>
		fireEvent.click(screen.getByRole("button", { name }));

	it("does not retract on the first tap", () => {
		ownPending();
		click("Retract");
		expect(vi.mocked(amendEvent)).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Yes, retract" })).not.toBeNull();
	});

	it("retracts on the second tap", async () => {
		ownPending();
		click("Retract");
		click("Yes, retract");
		await act(async () => {});
		expect(vi.mocked(amendEvent)).toHaveBeenCalledWith({
			kind: "retracted",
			target_event_id: "evt-1",
		});
	});

	it("cancelling drops the confirm without retracting", () => {
		ownPending();
		click("Retract");
		click("Cancel");
		expect(vi.mocked(amendEvent)).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Yes, retract" })).toBeNull();
		expect(screen.getByRole("button", { name: "Retract" })).not.toBeNull();
	});
});

/**
 * A citation reads as the term, not its id (#121, story 23). The pack change made
 * `rule_ref` a citing ref, so its stored value became a ULID — ADR 0005's "a ref
 * stops being readable", which tasks solved with a `task_name` beside the id. A
 * citation cannot: the name lives in the corpus and versions over time.
 */
describe("citations on the event card", () => {
	afterEach(cleanup);

	const MAR = 1_600_000_000_000;
	const term = (name: string, renamedTo?: string): VersionedAgreement => ({
		id: "ag_1",
		kind: "protocol",
		versions: [
			{ effective_from: MAR, name, text: "", retired: false },
			...(renamedTo
				? [
						{
							effective_from: MAR + 1_000,
							name: renamedTo,
							text: "",
							retired: false,
						},
					]
				: []),
		],
	});

	const cited = () =>
		event({
			type: "infraction",
			occurred_at: MAR + 500,
			composite_metadata: { rule_ref: "ag_1", severity: "minor" },
		});

	it("reads the term's name instead of its id", () => {
		renderStream([cited()], [term("no phone at dinner")]);
		expect(screen.getByText("Agreement: no phone at dinner")).not.toBeNull();
		expect(screen.queryByText(/ag_1/)).toBeNull();
	});

	it("shows the name in force then, and the current one beside it", () => {
		// Rendering only today's name would quietly restate what the person was
		// held to; showing only the old one would leave them unable to find it.
		renderStream([cited()], [term("no phone at dinner", "phones away")]);
		expect(
			screen.getByText("Agreement: no phone at dinner (now: phones away)"),
		).not.toBeNull();
	});

	it("falls back to the raw value for an id the couple doesn't hold", () => {
		// A free-text citation logged before the pack change, or a term deleted
		// while uncited. An opaque value beats a blank.
		renderStream([cited()], []);
		expect(screen.getByText("Agreement: ag_1")).not.toBeNull();
	});
});

/**
 * The drill-in is a disclosure, so it has to say whether it is open (#148) —
 * without `aria-expanded` a screen reader gets a button that silently grows a
 * chain below it.
 */
describe("the chain drill-in reports its state", () => {
	afterEach(cleanup);

	it("flips aria-expanded and names the region it reveals", async () => {
		renderStream([event({ type: "task_completed" })]);
		const toggle = screen.getAllByRole("button", { expanded: false })[0];
		expect(toggle.getAttribute("aria-controls")).not.toBeNull();
		expect(
			document.getElementById(toggle.getAttribute("aria-controls") ?? ""),
		).toBeNull();

		await act(async () => {
			fireEvent.click(toggle);
		});
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(
			document.getElementById(toggle.getAttribute("aria-controls") ?? ""),
		).not.toBeNull();
	});
});

/**
 * Responding to a partner's entry from the log (#183). The `response` amendment
 * has been implemented server-side since ADR 0001 and reachable from exactly one
 * screen — the conversation-flags reply — so the dom could react to "I want to
 * talk" and to nothing else the sub ever wrote. It matters more now that an act
 * carries `awaiting: []` (#182): a response is the only way the dom engages with
 * an act at all.
 */
describe("responding to a partner's entry", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(amendEvent).mockClear();
	});

	/** m2's entry, seen by m1 — the viewer in `renderStream`. */
	const theirs = (over: Partial<EventView> = {}) =>
		event({ type: "act", actor: "m2", ...over });

	it("offers Respond on a partner's entry, whatever its type", () => {
		// No type allowlist: an act, an orgasm, a completion and a journal entry
		// are the same question, and `canRespondTo` is where it is answered.
		for (const type of ["act", "orgasm", "task_completed", "journal_entry"]) {
			renderStream([theirs({ type })]);
			expect(screen.getByRole("button", { name: "Respond" })).not.toBeNull();
			cleanup();
		}
	});

	it("offers nothing on your own entry", () => {
		// A response to your own entry is meaningless — that is what a note is for.
		renderStream([event({ type: "act", actor: "m1" })]);
		expect(screen.queryByRole("button", { name: "Respond" })).toBeNull();
	});

	it("offers nothing on a secret entry", () => {
		renderStream([theirs({ type: "journal_entry", visibility: "secret" })]);
		expect(screen.queryByRole("button", { name: "Respond" })).toBeNull();
	});

	it("writes a response amendment carrying the prose", async () => {
		renderStream([theirs()]);
		fireEvent.click(screen.getByRole("button", { name: "Respond" }));
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "proud of you" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Respond" }));
		await act(async () => {});
		expect(vi.mocked(amendEvent)).toHaveBeenCalledWith({
			kind: "response",
			target_event_id: "evt-1",
			note: "proud of you",
		});
	});

	it("refuses an empty response", () => {
		// A response *is* the reaction, not an acknowledgement of one, so there has
		// to be something in it — the difference between this and a chip you tap away.
		renderStream([theirs()]);
		fireEvent.click(screen.getByRole("button", { name: "Respond" }));
		fireEvent.click(screen.getByRole("button", { name: "Respond" }));
		expect(vi.mocked(amendEvent)).not.toHaveBeenCalled();
		expect(screen.getByText("Write something back.")).not.toBeNull();
	});
});

/**
 * A partner's response lands behind the same content-safe reveal a ruling does
 * (#183). Two reasons, and either alone would be enough: "proud of you" is the
 * moment §8.3 calls emotionally load-bearing, and `ackUpdates` fires on the
 * reveal tap and nowhere else — so a response on an entry that carries no ruling
 * would otherwise raise a badge nobody could ever put down.
 */
describe("receiving a partner's response", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(ackUpdates).mockClear();
	});

	const responded = () =>
		renderStream([
			event({
				type: "journal_entry",
				actor: "m1",
				amendments: [
					{
						id: "am-1",
						target_event_id: "evt-1",
						kind: "response",
						actor: "m2",
						created_at: 1_700_000_001_000,
						note: "proud of you",
					} as Amendment,
				],
			}),
		]);

	it("holds the prose behind the reveal until it is tapped", () => {
		responded();
		expect(screen.queryByText(/proud of you/)).toBeNull();
		expect(
			screen.getByRole("button", { name: "You have an update — reveal" }),
		).not.toBeNull();
	});

	it("shows the response and marks updates seen on the tap", () => {
		responded();
		fireEvent.click(
			screen.getByRole("button", { name: "You have an update — reveal" }),
		);
		expect(screen.getByText(/proud of you/)).not.toBeNull();
		// The tap is the moment they actually receive it; acking on load would
		// clear the signal before they had read anything (#136).
		expect(vi.mocked(ackUpdates)).toHaveBeenCalled();
	});
});
