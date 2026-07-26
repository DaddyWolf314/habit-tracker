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
	amendEvent: vi.fn(() => Promise.resolve({})),
	getEventTrace: vi.fn(() => Promise.resolve({ rows: [] })),
}));

import { amendEvent } from "#/lib/api.ts";
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

function renderStream(events: EventView[]) {
	return render(
		<EventStream events={events} types={TYPES} members={MEMBERS} selfId="m1" />,
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
		expect(screen.getByText("floor: sealed")).not.toBeNull();
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
		expect(screen.getByText("task_name: dishes")).not.toBeNull();
		expect(screen.queryByText(/task_id/)).toBeNull();
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
		expect(screen.getByText("task_id: 01JB6X")).not.toBeNull();
	});

	it("hides nothing for a type the couple no longer has", () => {
		renderStream([
			event({ type: "gone", composite_metadata: { prompt_id: "01JB6X" } }),
		]);
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
