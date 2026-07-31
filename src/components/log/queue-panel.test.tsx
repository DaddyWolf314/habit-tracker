// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	amendEvent: vi.fn(() => Promise.resolve({})),
}));

import type { AnchorView } from "#/shared/anchors.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { VersionedRule } from "#/shared/rules.ts";
import { QueuePanel } from "./queue-panel.tsx";

/**
 * The dom's ruling buttons (#155, ADR 0008). This is the surface the issue was
 * filed about: the sub picked a quality in words and the dom was handed
 * `exceeded`, because the buttons rendered `field.options` straight through.
 *
 * The copy here is the pack's **neutral** phrasing rather than the sub's
 * claim-shaped map — the dom is ruling on the work, not reporting it — so these
 * pin the register as much as the de-slugging.
 */

const NOW = 1_700_000_000_000;

const MEMBERS: RoleMember[] = [
	{ member_id: "m1", role: "sub", is_self: false },
	{ member_id: "m2", role: "dom", is_self: true },
];

const TYPE: EventType = {
	id: "task_completed",
	label: "Task completed",
	valence: "positive",
	log_permission: ["dom", "sub", "switch"],
	subject_required: true,
	metadata: {
		quality: {
			kind: "enum",
			options: ["exceeded", "met", "partial"],
			option_labels: {
				exceeded: "Beyond what was asked",
				met: "What was asked",
				partial: "Part of the way",
			},
			label: "Quality",
			required: false,
			set_permission: ["dom", "sub", "switch"],
			adjudicated_by: ["dom"],
		},
		// No copy, and a multi-word token: the rung that has to hold for an enum a
		// couple wrote themselves.
		effort: {
			kind: "enum",
			options: ["went_easy", "pushed_through"],
			label: "Effort",
			required: false,
			set_permission: ["dom", "sub", "switch"],
			adjudicated_by: ["dom"],
		},
	},
	awaiting: ["quality", "effort"],
	journaling: false,
};

const PENDING: EventView = {
	id: "e1",
	type: "task_completed",
	actor: "m1",
	subject: "m1",
	occurred_at: NOW - 60_000,
	logged_at: NOW - 60_000,
	metadata: {},
	visibility: "shared",
	amendments: [],
	composite_metadata: {},
	pending: true,
	retracted: false,
};

const RULES: VersionedRule[] = [];
const ANCHORS: AnchorView[] = [];

function renderQueue(events: EventView[] = [PENDING]) {
	return render(
		<QueuePanel
			events={events}
			types={[TYPE]}
			rules={RULES}
			members={MEMBERS}
			anchors={ANCHORS}
			timers={[]}
			selfRole="dom"
			onAmended={() => {}}
		/>,
	);
}

describe("the dom's ruling buttons", () => {
	afterEach(cleanup);

	it("offers each option in words, never the stored token", () => {
		renderQueue();
		for (const label of [
			"Beyond what was asked",
			"What was asked",
			"Part of the way",
		]) {
			expect(screen.getByRole("button", { name: label })).not.toBeNull();
		}
		expect(screen.queryByRole("button", { name: "exceeded" })).toBeNull();
	});

	it("de-slugs an option the couple wrote no copy for", () => {
		renderQueue();
		expect(screen.getByRole("button", { name: "went easy" })).not.toBeNull();
		expect(screen.queryByRole("button", { name: "went_easy" })).toBeNull();
	});

	it("shows an already-set value in the same words", () => {
		// The context chip and the buttons are the same vocabulary; a dom reading
		// `partial` beside a button offering "Part of the way" is the same defect
		// one rung along.
		renderQueue([{ ...PENDING, composite_metadata: { quality: "partial" } }]);
		expect(screen.getByText(/Part of the way/)).not.toBeNull();
	});
});
