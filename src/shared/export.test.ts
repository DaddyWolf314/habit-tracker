import { describe, expect, it } from "vitest";
import type { Amendment } from "./amendments.ts";
import type { AnchorView } from "./anchors.ts";
import type { Counter } from "./counters.ts";
import type { Event } from "./events.ts";
import {
	amendmentToExportRow,
	anchorToExportRow,
	counterToExportRow,
	eventToExportRow,
	ruleToExportRow,
	timerToExportRow,
} from "./export.ts";
import type { Rule } from "./rules.ts";
import type { TimerView } from "./timers.ts";

/**
 * The export is the abuse-edge escape hatch (handoff §2): a member's full view
 * of the relationship as portable JSON. `ExportRow` is deliberately flat so it
 * crosses the DO RPC boundary cleanly, so every flattener must (a) carry all of
 * a domain object's fields, (b) serialize nested values as JSON strings, and
 * (c) turn absent optionals into `null` — never `undefined`, which JSON drops.
 */

describe("eventToExportRow", () => {
	const event: Event = {
		id: "evt-1",
		type: "chore_done",
		actor: "member-a",
		subject: "member-b",
		occurred_at: 1000,
		logged_at: 1500,
		metadata: { quality: "good", count: 3 },
		note: "nice work",
	};

	it("carries every field, serializing metadata", () => {
		expect(eventToExportRow(event)).toEqual({
			id: "evt-1",
			type: "chore_done",
			actor: "member-a",
			subject: "member-b",
			occurred_at: 1000,
			logged_at: 1500,
			metadata: JSON.stringify({ quality: "good", count: 3 }),
			note: "nice work",
		});
	});

	it("maps absent optionals to null", () => {
		const bare: Event = {
			id: "evt-2",
			type: "note",
			actor: "member-a",
			occurred_at: 1,
			logged_at: 1,
			metadata: {},
		};
		const row = eventToExportRow(bare);
		expect(row.subject).toBeNull();
		expect(row.note).toBeNull();
		expect(row.metadata).toBe("{}");
	});
});

describe("counterToExportRow", () => {
	it("carries the full definition, serializing streak and permissions", () => {
		const counter: Counter = {
			id: "streak",
			name: "Streak",
			valence: "positive",
			daily_target: 1,
			reset: "never",
			streak: { counter: "chores", period: "daily" },
			modify_permission: ["dom"],
			value: 5,
			updated_at: 900,
		};
		expect(counterToExportRow(counter)).toEqual({
			id: "streak",
			name: "Streak",
			valence: "positive",
			daily_target: 1,
			weekly_target: null,
			reset: "never",
			streak: JSON.stringify({ counter: "chores", period: "daily" }),
			modify_permission: JSON.stringify(["dom"]),
			value: 5,
			updated_at: 900,
		});
	});

	it("nulls an absent streak rather than dropping the binding", () => {
		const counter: Counter = {
			id: "chores",
			name: "Chores",
			valence: "neutral",
			reset: "daily",
			modify_permission: ["dom", "sub", "switch"],
			value: 0,
			updated_at: null,
		};
		const row = counterToExportRow(counter);
		expect(row.streak).toBeNull();
		expect(row.daily_target).toBeNull();
		expect(row.weekly_target).toBeNull();
	});
});

describe("amendmentToExportRow", () => {
	it("carries an adjudication's patch and supersedes", () => {
		const amendment: Amendment = {
			kind: "adjudication",
			id: "amd-1",
			target_event_id: "evt-1",
			actor: "member-a",
			created_at: 2000,
			patch: { verdict: "pass" },
			note: "ruled",
			supersedes: "amd-0",
		};
		expect(amendmentToExportRow(amendment)).toEqual({
			id: "amd-1",
			target_event_id: "evt-1",
			kind: "adjudication",
			actor: "member-a",
			created_at: 2000,
			patch: JSON.stringify({ verdict: "pass" }),
			note: "ruled",
			supersedes: "amd-0",
		});
	});

	it("flattens a retraction with null patch/supersedes", () => {
		const amendment: Amendment = {
			kind: "retracted",
			id: "amd-2",
			target_event_id: "evt-2",
			actor: "member-b",
			created_at: 2100,
		};
		expect(amendmentToExportRow(amendment)).toEqual({
			id: "amd-2",
			target_event_id: "evt-2",
			kind: "retracted",
			actor: "member-b",
			created_at: 2100,
			patch: null,
			note: null,
			supersedes: null,
		});
	});

	it("carries a note_appended's required note", () => {
		const amendment: Amendment = {
			kind: "note_appended",
			id: "amd-3",
			target_event_id: "evt-3",
			actor: "member-b",
			created_at: 2200,
			note: "context",
		};
		const row = amendmentToExportRow(amendment);
		expect(row.note).toBe("context");
		expect(row.patch).toBeNull();
		expect(row.supersedes).toBeNull();
	});
});

describe("ruleToExportRow", () => {
	it("serializes the condition and effects", () => {
		const rule: Rule = {
			id: "custom-1",
			condition: { type: "chore_done", metadata: {} },
			effects: [{ verb: "increment_counter", counter: "chores", by: 1 }],
			enabled: true,
		};
		expect(ruleToExportRow(rule)).toEqual({
			id: "custom-1",
			condition: JSON.stringify(rule.condition),
			effects: JSON.stringify(rule.effects),
			enabled: true,
		});
	});
});

describe("timerToExportRow", () => {
	it("carries every field, serializing the match", () => {
		const timer: TimerView = {
			id: "tmr-1",
			kind: "stopwatch",
			timer: "session_stopwatch",
			tag: "focus",
			match: { room: "office" },
			opened_at: 100,
			closed_at: null,
			status: null,
			duration_ms: null,
			deadline_at: null,
			paused_at: null,
			remaining_ms: null,
		};
		expect(timerToExportRow(timer)).toEqual({
			id: "tmr-1",
			kind: "stopwatch",
			timer: "session_stopwatch",
			tag: "focus",
			match: JSON.stringify({ room: "office" }),
			opened_at: 100,
			closed_at: null,
			status: null,
			duration_ms: null,
			deadline_at: null,
			paused_at: null,
			remaining_ms: null,
		});
	});
});

describe("anchorToExportRow", () => {
	it("carries the anchor snapshot verbatim", () => {
		const anchor: AnchorView = {
			anchor: "since_last_slip",
			since: 500,
			elapsed_ms: 1500,
			elapsed_days: 0,
		};
		expect(anchorToExportRow(anchor)).toEqual({
			anchor: "since_last_slip",
			since: 500,
			elapsed_ms: 1500,
			elapsed_days: 0,
		});
	});
});
