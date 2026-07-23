import { describe, expect, it } from "vitest";
import {
	awaitedRulings,
	describeAmendment,
	isOwnPending,
} from "./adjudication.ts";
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
		visibility: "shared",
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

	describe("subject-qualified awaiting entries (ADR 0003)", () => {
		const qualifiedType = {
			...type,
			awaiting: [{ key: "permitted", subject_role: "sub" }],
		} as unknown as EventType;

		it("asks for the ruling when the subject resolves to the qualified role", () => {
			const rulings = awaitedRulings(event(), qualifiedType, "dom", "sub");
			expect(rulings.map((r) => r.key)).toEqual(["permitted"]);
		});

		it("asks for no ruling on a dom-subject event — nobody adjudicates the authority", () => {
			// Even if a stale `pending` flag reached the client, the entry is not in
			// force for a dom subject, so the queue never shows a card.
			expect(awaitedRulings(event(), qualifiedType, "dom", "dom")).toEqual([]);
		});

		it("asks for no ruling when the subject role is unresolved", () => {
			expect(awaitedRulings(event(), qualifiedType, "dom", undefined)).toEqual(
				[],
			);
		});

		it("bare entries keep asking regardless of subject role", () => {
			expect(
				awaitedRulings(event(), type, "dom", "dom").map((r) => r.key),
			).toEqual(["permitted"]);
		});
	});
});

describe("isOwnPending", () => {
	it("is true only for the author's own still-pending, un-retracted event", () => {
		expect(isOwnPending(event(), "sub-1")).toBe(true); // author, pending
		expect(isOwnPending(event(), "dom-1")).toBe(false); // not the author
		expect(isOwnPending(event({ pending: false }), "sub-1")).toBe(false);
		expect(isOwnPending(event({ retracted: true }), "sub-1")).toBe(false);
		expect(isOwnPending(event(), null)).toBe(false);
	});
});

describe("describeAmendment — one line of the chain view (handoff §4.6)", () => {
	const meta = {
		id: "x",
		target_event_id: "e1",
		actor: "dom-1",
		created_at: 5,
	};

	it("describes a ruling with its patched keys and values", () => {
		const line = describeAmendment({
			kind: "adjudication",
			...meta,
			patch: { permitted: true },
			note: "as agreed",
		});
		expect(line.tone).toBe("ruling");
		expect(line.summary).toContain("permitted: yes");
		expect(line.note).toBe("as agreed");
		expect(line.actor).toBe("dom-1");
		expect(line.at).toBe(5);
	});

	it("marks a correction as a revised ruling", () => {
		const line = describeAmendment({
			kind: "adjudication",
			...meta,
			patch: { permitted: false },
			supersedes: "a1",
		});
		expect(line.summary).toMatch(/revis/i);
	});

	it("describes an appended note", () => {
		const line = describeAmendment({
			kind: "note_appended",
			...meta,
			note: "context",
		});
		expect(line.tone).toBe("note");
		expect(line.note).toBe("context");
	});

	it("describes a retraction", () => {
		const line = describeAmendment({ kind: "retracted", ...meta });
		expect(line.tone).toBe("retraction");
		expect(line.summary).toMatch(/retract/i);
	});
});
