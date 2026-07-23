import { describe, expect, it } from "vitest";
import { ulid } from "#/lib/ulid.ts";
import {
	COUNTER_ADJUSTED_TYPE,
	COUNTER_RESET_TYPE,
} from "#/templates/index.ts";
import type { Amendment } from "./amendments.ts";
import type { Event } from "./events.ts";
import {
	applyCounterEvent,
	type CounterEventInput,
	compositeMetadata,
	deriveEventView,
	isPending,
	isRetracted,
	replayCounterValue,
} from "./projections.ts";

function adjust(counter: string, delta: number, at: number): CounterEventInput {
	return {
		type: COUNTER_ADJUSTED_TYPE,
		logged_at: at,
		id: ulid(at),
		metadata: { counter, delta },
	};
}

describe("counter projection", () => {
	it("folds adjustments and resets", () => {
		expect(applyCounterEvent(3, adjust("c", 2, 1))).toBe(5);
		expect(applyCounterEvent(3, adjust("c", -1, 1))).toBe(2);
		expect(
			applyCounterEvent(9, {
				type: COUNTER_RESET_TYPE,
				logged_at: 1,
				id: "x",
				metadata: { counter: "c" },
			}),
		).toBe(0);
	});

	it("ignores non-counter and other-counter events on replay", () => {
		const events: CounterEventInput[] = [
			adjust("demerits", 2, 10),
			adjust("praise", 5, 11),
			adjust("demerits", 1, 12),
			{ type: "note", logged_at: 13, id: ulid(13), metadata: {} },
		];
		expect(replayCounterValue("demerits", events)).toBe(3);
		expect(replayCounterValue("praise", events)).toBe(5);
	});

	it("replay reproduces the incrementally-applied value, resets included", () => {
		const events = [
			adjust("c", 1, 1),
			adjust("c", 1, 2),
			{
				type: COUNTER_RESET_TYPE,
				logged_at: 3,
				id: ulid(3),
				metadata: { counter: "c" },
			},
			adjust("c", 4, 4),
		];
		// Incremental application in append order.
		let live = 0;
		for (const e of events) live = applyCounterEvent(live, e);
		expect(replayCounterValue("c", events)).toBe(live);
		expect(live).toBe(4);
	});

	it("replay is order-independent of input array (sorts by logged_at)", () => {
		const events = [adjust("c", 5, 30), adjust("c", 2, 10), adjust("c", 3, 20)];
		expect(replayCounterValue("c", events)).toBe(10);
		expect(replayCounterValue("c", [...events].reverse())).toBe(10);
	});
});

describe("composite state + pending", () => {
	const base = { metadata: { outcome: "full" } };

	it("with no amendments, composite equals the original", () => {
		expect(compositeMetadata(base, [])).toEqual({ outcome: "full" });
	});

	it("overlays adjudications in created_at order, respecting supersedes", () => {
		const amendments: Amendment[] = [
			{
				kind: "adjudication",
				id: "a1",
				target_event_id: "e",
				actor: "d",
				created_at: 1,
				patch: { permitted: false },
			},
			{
				kind: "adjudication",
				id: "a2",
				target_event_id: "e",
				actor: "d",
				created_at: 2,
				patch: { permitted: true },
				supersedes: "a1",
			},
		];
		expect(compositeMetadata(base, amendments)).toEqual({
			outcome: "full",
			permitted: true,
		});
	});

	it("is pending while an awaiting key is unset, resolved once present", () => {
		const type = { awaiting: ["permitted"] };
		expect(isPending(type, { outcome: "full" })).toBe(true);
		expect(isPending(type, { outcome: "full", permitted: true })).toBe(false);
		expect(isPending(type, { outcome: "full" }, true)).toBe(false); // retracted
	});

	it("a subject-qualified entry gates pending only for its role (ADR 0003)", () => {
		const type = {
			awaiting: [{ key: "permitted", subject_role: "sub" as const }],
		};
		// Sub-subject event: unchanged — pending until `permitted` is ruled.
		expect(isPending(type, {}, false, "sub")).toBe(true);
		expect(isPending(type, { permitted: true }, false, "sub")).toBe(false);
		// Dom-subject event: never pending — nobody adjudicates the authority.
		expect(isPending(type, {}, false, "dom")).toBe(false);
		// No subject / unresolved role: the qualified entry is not in force.
		expect(isPending(type, {}, false, undefined)).toBe(false);
	});

	it("bare keys keep gating regardless of subject alongside qualified ones", () => {
		const type = {
			awaiting: [
				"severity",
				{ key: "permitted", subject_role: "sub" as const },
			],
		};
		expect(isPending(type, {}, false, "dom")).toBe(true); // severity still gates
		expect(isPending(type, { severity: "minor" }, false, "dom")).toBe(false);
		expect(isPending(type, { severity: "minor" }, false, "sub")).toBe(true);
	});
});

describe("isRetracted", () => {
	const meta = { id: "a", target_event_id: "e", actor: "s", created_at: 1 };
	const adjudication: Amendment = { kind: "adjudication", patch: {}, ...meta };
	const note: Amendment = { kind: "note_appended", note: "hi", ...meta };
	const retracted: Amendment = { kind: "retracted", ...meta };

	it("is true only when a retracted amendment is present", () => {
		expect(isRetracted([])).toBe(false);
		expect(isRetracted([note])).toBe(false);
		expect(isRetracted([adjudication])).toBe(false);
		expect(isRetracted([retracted])).toBe(true);
	});
});

describe("deriveEventView — the composite read view (handoff §4.2, §4.6)", () => {
	const event: Event = {
		id: "e1",
		type: "orgasm",
		actor: "sub-1",
		occurred_at: 10,
		logged_at: 10,
		visibility: "shared",
		metadata: { outcome: "full" },
	};
	const type = { awaiting: ["permitted"] };

	it("with no amendments, composite equals the original and is pending", () => {
		const view = deriveEventView(event, [], type);
		expect(view.composite_metadata).toEqual({ outcome: "full" });
		expect(view.amendments).toEqual([]);
		expect(view.pending).toBe(true);
		expect(view.retracted).toBe(false);
		// The raw event is carried through untouched — nothing is stored.
		expect(view.metadata).toEqual({ outcome: "full" });
	});

	it("folds multiple amendments in created_at order, corrections winning per key", () => {
		const amendments: Amendment[] = [
			// Deliberately out of insertion order to prove sorting by created_at.
			{
				kind: "adjudication",
				id: "a2",
				target_event_id: "e1",
				actor: "dom-1",
				created_at: 3,
				patch: { permitted: true },
				supersedes: "a1",
			},
			{
				kind: "adjudication",
				id: "a1",
				target_event_id: "e1",
				actor: "dom-1",
				created_at: 2,
				patch: { permitted: false },
			},
			// A note never touches composite state.
			{
				kind: "note_appended",
				id: "n1",
				target_event_id: "e1",
				actor: "sub-1",
				created_at: 4,
				note: "context",
			},
		];
		const view = deriveEventView(event, amendments, type);
		expect(view.composite_metadata).toEqual({
			outcome: "full",
			permitted: true,
		});
		expect(view.pending).toBe(false); // permitted is now set
		expect(view.retracted).toBe(false);
	});

	it("a retracted event is not pending and is flagged retracted", () => {
		const amendments: Amendment[] = [
			{
				kind: "retracted",
				id: "r1",
				target_event_id: "e1",
				actor: "sub-1",
				created_at: 2,
			},
		];
		const view = deriveEventView(event, amendments, type);
		expect(view.retracted).toBe(true);
		expect(view.pending).toBe(false);
	});

	it("without a known type, pending is false (unknown types touch nothing)", () => {
		expect(deriveEventView(event, [], undefined).pending).toBe(false);
	});

	it("threads the subject role into pending (ADR 0003)", () => {
		const qualified = {
			awaiting: [{ key: "permitted", subject_role: "sub" as const }],
		};
		// A dom-subject orgasm with `permitted` unset is never pending — it enters
		// no queue and inflates no notification count (the count is derived from
		// `pending`); the sub-subject flow is unchanged.
		expect(deriveEventView(event, [], qualified, "dom").pending).toBe(false);
		expect(deriveEventView(event, [], qualified, "sub").pending).toBe(true);
	});
});

describe("ulid", () => {
	it("is 26 chars and lexicographically sorts by time", () => {
		const a = ulid(1000);
		const b = ulid(2000);
		expect(a).toHaveLength(26);
		expect(b).toHaveLength(26);
		expect(a < b).toBe(true);
	});

	it("is strictly monotonic within a single millisecond", () => {
		// Same timestamp minted repeatedly must still increase, so replay's
		// (logged_at, id) tie-break reproduces append order.
		const ids = Array.from({ length: 50 }, () => ulid(5000));
		for (let i = 1; i < ids.length; i++) {
			expect(ids[i - 1] < ids[i]).toBe(true);
		}
	});
});
