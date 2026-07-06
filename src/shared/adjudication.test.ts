import { describe, expect, it } from "vitest";
import { activeRuling, awaitedRulings } from "./adjudication.ts";
import type { Amendment } from "./amendments.ts";
import type { EventType } from "./event-types.ts";
import type { EventView } from "./events.ts";

const type = {
	id: "orgasm",
	label: "Orgasm",
	valence: "neutral",
	log_permission: ["sub"],
	subject_required: false,
	awaiting: ["permitted"],
	metadata: {
		permitted: {
			kind: "boolean",
			label: "Permitted",
			required: false,
			set_permission: [],
			adjudicated_by: ["dom"],
		},
	},
} as unknown as EventType;

function event(over: Partial<EventView> = {}): EventView {
	return {
		id: "e1",
		type: "orgasm",
		actor: "sub-1",
		occurred_at: 1,
		logged_at: 1,
		metadata: {},
		amendments: [],
		composite_metadata: {},
		pending: true,
		retracted: false,
		...over,
	};
}

describe("awaitedRulings", () => {
	it("lists awaited, unset keys a role may rule, with their field defs", () => {
		const rulings = awaitedRulings(event(), type, "dom");
		expect(rulings.map((r) => r.key)).toEqual(["permitted"]);
		expect(rulings[0].field.kind).toBe("boolean");
	});

	it("is empty for a role that may not adjudicate the key", () => {
		expect(awaitedRulings(event(), type, "sub")).toEqual([]);
	});

	it("is empty once the key is set in composite (resolved)", () => {
		const resolved = event({
			pending: false,
			composite_metadata: { permitted: true },
		});
		expect(awaitedRulings(resolved, type, "dom")).toEqual([]);
	});

	it("is empty for a retracted event", () => {
		expect(awaitedRulings(event({ retracted: true }), type, "dom")).toEqual([]);
	});
});

describe("activeRuling", () => {
	const adj = (
		id: string,
		created_at: number,
		value: boolean,
		supersedes?: string,
	): Amendment => ({
		kind: "adjudication",
		id,
		target_event_id: "e1",
		actor: "dom-1",
		created_at,
		patch: { permitted: value },
		supersedes,
	});

	it("returns the ruling currently in force for a key", () => {
		const ruling = activeRuling([adj("a1", 10, false)], "permitted");
		expect(ruling).toEqual({ id: "a1", value: false });
	});

	it("follows a correction to the superseding ruling", () => {
		const ruling = activeRuling(
			[adj("a1", 10, false), adj("a2", 20, true, "a1")],
			"permitted",
		);
		expect(ruling).toEqual({ id: "a2", value: true });
	});

	it("is undefined when no ruling touches the key", () => {
		expect(activeRuling([], "permitted")).toBeUndefined();
	});
});
