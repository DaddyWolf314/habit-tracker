import { describe, expect, it } from "vitest";
import {
	closeStopwatch,
	durationMinutes,
	matchStopwatch,
	type OpenStopwatch,
	stopwatchDurationMs,
	stopwatchesToAutoClose,
} from "./timers.ts";

/** A small helper mirroring the DO's stored open-stopwatch shape. */
function open(
	id: string,
	match: OpenStopwatch["match"],
	opened_at: number,
	tag?: string,
): OpenStopwatch {
	return { id, timer: "session_stopwatch", match, opened_at, tag };
}

describe("stopwatch duration (handoff §4.5 — derived on close)", () => {
	it("is the elapsed span between open and close", () => {
		expect(stopwatchDurationMs(1_000, 61_000)).toBe(60_000);
	});

	it("never goes negative (a close before the open clamps to 0)", () => {
		expect(stopwatchDurationMs(61_000, 1_000)).toBe(0);
	});

	it("routes into a minutes counter by whole floored minutes", () => {
		// 37m30s of service => +37 to service_minutes_week (rules route, don't round up).
		expect(durationMinutes(37 * 60_000 + 30_000)).toBe(37);
	});
});

describe("matching a close to its open (handoff §4.5 — no orphan closes)", () => {
	const opens = [
		open("sw1", { session_id: "s1" }, 1_000, "service"),
		open("sw2", { session_id: "s2" }, 2_000, "kneeling"),
	];

	it("finds the open whose match keys all equal the resolved close match", () => {
		expect(matchStopwatch(opens, { session_id: "s2" })?.id).toBe("sw2");
	});

	it("returns undefined for a session with no open stopwatch (orphan `ended`)", () => {
		expect(matchStopwatch(opens, { session_id: "s9" })).toBeUndefined();
	});

	it("returns undefined when the close pins no key (never matches all opens)", () => {
		// engine.resolveMatchOn drops unset keys; an empty match must reject, not
		// match-any — otherwise an ended with no session_id would close a stranger's.
		expect(matchStopwatch(opens, {})).toBeUndefined();
		expect(matchStopwatch(opens, undefined)).toBeUndefined();
	});
});

describe("closing a stopwatch", () => {
	it("derives duration and marks it completed", () => {
		const sw = open("sw1", { session_id: "s1" }, 1_000, "service");
		expect(closeStopwatch(sw, 61_000)).toEqual({
			...sw,
			closed_at: 61_000,
			duration_ms: 60_000,
			status: "completed",
			flagged_for_review: false,
		});
	});

	it("flags an auto-close for review (over-max session)", () => {
		const sw = open("sw1", { session_id: "s1" }, 1_000, "service");
		expect(closeStopwatch(sw, 61_000, { auto: true })).toMatchObject({
			status: "auto_closed",
			flagged_for_review: true,
		});
	});
});

describe("auto-closing over-max sessions (handoff §4.5)", () => {
	const maxByTag = { service: 60_000, kneeling: 30_000 };

	it("selects only sessions that have run past their per-activity max", () => {
		const opens = [
			open("sw1", { session_id: "s1" }, 0, "service"), // 100s old, max 60s → close
			open("sw2", { session_id: "s2" }, 90_000, "kneeling"), // 10s old → keep
		];
		const due = stopwatchesToAutoClose(opens, 100_000, maxByTag, 120_000);
		expect(due.map((d) => d.id)).toEqual(["sw1"]);
	});

	it("falls back to the default max when the tag has no configured limit", () => {
		const opens = [open("sw1", { session_id: "s1" }, 0, "scene")];
		expect(
			stopwatchesToAutoClose(opens, 130_000, maxByTag, 120_000),
		).toHaveLength(1);
		expect(
			stopwatchesToAutoClose(opens, 110_000, maxByTag, 120_000),
		).toHaveLength(0);
	});
});
