import { describe, expect, it } from "vitest";
import {
	awaitedRulings,
	canRespondTo,
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

/**
 * The respond gate (#183) mirrors `validateResponse`, so the affordance appears
 * on exactly the rows the server will accept a response for — and, crucially, it
 * asks about authorship and visibility rather than about the event's *type*. A
 * client-side allowlist of respondable types would be a second answer to a
 * question validation already answers, and would silently omit every type the
 * pack grows next.
 */
describe("canRespondTo", () => {
	it("is true for a partner's shared entry, whatever its type", () => {
		expect(canRespondTo(event(), "dom-1")).toBe(true);
		// Nothing here reads `type`: an act, an orgasm, a completion and a journal
		// entry are the same question, which is the point of the gate.
		expect(canRespondTo(event({ type: "act" }), "dom-1")).toBe(true);
		expect(canRespondTo(event({ type: "journal_entry" }), "dom-1")).toBe(true);
	});

	it("is false on your own entry", () => {
		// Responding to yourself is meaningless — that is what a note is for.
		expect(canRespondTo(event(), "sub-1")).toBe(false);
	});

	it("is false on a secret entry", () => {
		// The dom must not learn a secret entry even exists; the read model already
		// omits it, and this refuses the same thing on the way in (ADR 0001).
		expect(canRespondTo(event({ visibility: "secret" }), "dom-1")).toBe(false);
	});

	it("is true on a sealed entry", () => {
		// Sealed prose stays hidden, but the funnel gives the responder the
		// existence row — a response is exactly what ADR 0001 allows there.
		expect(canRespondTo(event({ visibility: "sealed" }), "dom-1")).toBe(true);
	});

	it("is false once the entry is retracted", () => {
		// `validateAmendment` refuses every amendment on a retracted event before
		// `validateResponse` is even reached, so the button could only ever fail.
		expect(canRespondTo(event({ retracted: true }), "dom-1")).toBe(false);
	});

	it("is false for a viewer with no member id", () => {
		expect(canRespondTo(event(), null)).toBe(false);
	});

	it("does not care whether the entry is still pending", () => {
		// An act carries `awaiting: []` and so is never pending (#182). A response
		// is the only way the dom engages with one at all.
		expect(canRespondTo(event({ pending: false }), "dom-1")).toBe(true);
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
