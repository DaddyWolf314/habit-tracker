import { describe, expect, it } from "vitest";
import {
	type AmendmentContext,
	adjudicableKeys,
	validateAmendment,
} from "./amendment-validation.ts";
import type { Amendment, AmendmentInput } from "./amendments.ts";
import type { EventType } from "./event-types.ts";

/**
 * A pending `orgasm`-shaped type: `permitted` is dom-adjudicated and awaited,
 * `kind` is a sub-set enum nobody may adjudicate. Mirrors the starter seven.
 */
const type: Pick<EventType, "metadata" | "awaiting"> = {
	awaiting: ["permitted"],
	metadata: {
		permitted: {
			kind: "boolean",
			label: "Permitted",
			required: false,
			set_permission: [],
			adjudicated_by: ["dom"],
		},
		kind: {
			kind: "enum",
			label: "Kind",
			required: false,
			options: ["full", "edge"],
			set_permission: ["sub"],
		},
	},
};

function ctx(over: Partial<AmendmentContext> = {}): AmendmentContext {
	return {
		event: { actor: "sub-1", metadata: {} },
		eventType: type,
		actorRole: "dom",
		actorMemberId: "dom-1",
		amendments: [],
		...over,
	};
}

function adjudication(
	over: Partial<Extract<Amendment, { kind: "adjudication" }>>,
): Amendment {
	return {
		kind: "adjudication",
		id: "a-existing",
		target_event_id: "e1",
		actor: "dom-1",
		created_at: 100,
		patch: { permitted: false },
		...over,
	};
}

const adjudicate = (
	over: Partial<Extract<AmendmentInput, { kind: "adjudication" }>> = {},
): AmendmentInput => ({
	kind: "adjudication",
	target_event_id: "e1",
	patch: { permitted: true },
	...over,
});

describe("adjudicableKeys", () => {
	it("lists keys a role may rule on, and nothing for other roles", () => {
		expect(adjudicableKeys(type, "dom")).toEqual(["permitted"]);
		expect(adjudicableKeys(type, "sub")).toEqual([]);
		expect(adjudicableKeys(type, null)).toEqual([]);
	});
});

describe("adjudication — patches only permitted keys", () => {
	it("accepts a dom ruling on an adjudicated key", () => {
		expect(validateAmendment(adjudicate(), ctx())).toEqual({ ok: true });
	});

	it("rejects a role not listed in adjudicated_by", () => {
		const result = validateAmendment(adjudicate(), ctx({ actorRole: "sub" }));
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("permitted");
	});

	it("rejects a patch on an unknown key", () => {
		const result = validateAmendment(
			adjudicate({ patch: { wombat: true } }),
			ctx(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("wombat");
	});

	it("rejects a patch on a key with no adjudicated_by", () => {
		const result = validateAmendment(
			adjudicate({ patch: { kind: "edge" } }),
			ctx(),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects a value of the wrong kind", () => {
		const result = validateAmendment(
			adjudicate({ patch: { permitted: "yes" } }),
			ctx(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("boolean");
	});

	it("rejects an empty patch", () => {
		const result = validateAmendment(adjudicate({ patch: {} }), ctx());
		expect(result.ok).toBe(false);
	});
});

describe("adjudication — corrections supersede, one active ruling per key", () => {
	it("accepts a correction that supersedes the prior ruling", () => {
		const prior = adjudication({ id: "a1", patch: { permitted: false } });
		const result = validateAmendment(
			adjudicate({ patch: { permitted: true }, supersedes: "a1" }),
			ctx({ amendments: [prior] }),
		);
		expect(result).toEqual({ ok: true });
	});

	it("rejects re-ruling an already-ruled key without superseding", () => {
		const prior = adjudication({ id: "a1", patch: { permitted: false } });
		const result = validateAmendment(
			adjudicate({ patch: { permitted: true } }),
			ctx({ amendments: [prior] }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("already");
	});

	it("rejects superseding an unknown amendment", () => {
		const result = validateAmendment(
			adjudicate({ supersedes: "ghost" }),
			ctx(),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects superseding an already-superseded ruling", () => {
		const a1 = adjudication({ id: "a1", created_at: 100 });
		const a2 = adjudication({
			id: "a2",
			created_at: 200,
			patch: { permitted: true },
			supersedes: "a1",
		});
		const result = validateAmendment(
			adjudicate({ patch: { permitted: false }, supersedes: "a1" }),
			ctx({ amendments: [a1, a2] }),
		);
		expect(result.ok).toBe(false);
	});
});

describe("note_appended — own pending event", () => {
	it("accepts a note from the event author while pending", () => {
		const input: AmendmentInput = {
			kind: "note_appended",
			target_event_id: "e1",
			note: "context",
		};
		expect(validateAmendment(input, ctx({ actorMemberId: "sub-1" }))).toEqual({
			ok: true,
		});
	});

	it("rejects a note from someone other than the author", () => {
		const input: AmendmentInput = {
			kind: "note_appended",
			target_event_id: "e1",
			note: "context",
		};
		expect(validateAmendment(input, ctx({ actorMemberId: "dom-1" })).ok).toBe(
			false,
		);
	});

	it("rejects a note once the event is resolved (not pending)", () => {
		const input: AmendmentInput = {
			kind: "note_appended",
			target_event_id: "e1",
			note: "context",
		};
		const resolved = ctx({
			actorMemberId: "sub-1",
			event: { actor: "sub-1", metadata: { permitted: true } },
		});
		expect(validateAmendment(input, resolved).ok).toBe(false);
	});
});

describe("retracted — sub-authored, only while pending, terminal", () => {
	const retract: AmendmentInput = { kind: "retracted", target_event_id: "e1" };

	it("accepts a retraction from the author while pending", () => {
		expect(validateAmendment(retract, ctx({ actorMemberId: "sub-1" }))).toEqual(
			{
				ok: true,
			},
		);
	});

	it("rejects a retraction by a non-author", () => {
		expect(validateAmendment(retract, ctx({ actorMemberId: "dom-1" })).ok).toBe(
			false,
		);
	});

	it("rejects a retraction once the event is no longer pending", () => {
		const resolved = ctx({
			actorMemberId: "sub-1",
			event: { actor: "sub-1", metadata: { permitted: true } },
		});
		expect(validateAmendment(retract, resolved).ok).toBe(false);
	});

	it("rejects any amendment targeting an already-retracted event", () => {
		const retraction: Amendment = {
			kind: "retracted",
			id: "r1",
			target_event_id: "e1",
			actor: "sub-1",
			created_at: 100,
		};
		expect(
			validateAmendment(
				retract,
				ctx({ actorMemberId: "sub-1", amendments: [retraction] }),
			).ok,
		).toBe(false);
		expect(
			validateAmendment(adjudicate(), ctx({ amendments: [retraction] })).ok,
		).toBe(false);
	});
});
