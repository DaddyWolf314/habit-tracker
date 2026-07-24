import { describe, expect, it } from "vitest";
import {
	type Countdown,
	closeStopwatch,
	countdownExpiryAt,
	countdownRemainingMs,
	durationMinutes,
	durationToMs,
	extendChoicesFor,
	extendCountdown,
	formatElapsed,
	formatRemaining,
	isCountdownExpired,
	matchStopwatch,
	type OpenStopwatch,
	pauseCountdown,
	reprojectAcrossPause,
	resumeCountdown,
	stopwatchDurationMs,
	stopwatchesToAutoClose,
} from "./timers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

describe("countdowns (handoff §4.5 — deadline timers)", () => {
	/** A running countdown assigned at t=0 for 100s. */
	function running(): Countdown {
		return { opened_at: 0, deadline_at: 100_000 };
	}

	it("remaining time counts down toward the deadline (running)", () => {
		expect(countdownRemainingMs(running(), 40_000)).toBe(60_000);
	});

	it("never reports negative remaining once past the deadline", () => {
		expect(countdownRemainingMs(running(), 130_000)).toBe(0);
	});

	it("is expired only while running and past its deadline", () => {
		expect(isCountdownExpired(running(), 90_000)).toBe(false);
		expect(isCountdownExpired(running(), 100_000)).toBe(true);
		// A paused countdown never expires — life intruded; the clock is frozen.
		const paused = pauseCountdown(running(), 40_000);
		expect(isCountdownExpired({ ...running(), ...paused }, 200_000)).toBe(
			false,
		);
	});

	it("pause freezes the remaining time", () => {
		expect(pauseCountdown(running(), 40_000)).toEqual({
			paused_at: 40_000,
			remaining_ms: 60_000,
		});
	});

	it("resume re-projects the frozen remaining onto a fresh deadline", () => {
		const paused: Countdown = {
			opened_at: 0,
			deadline_at: 100_000,
			paused_at: 40_000,
			remaining_ms: 60_000,
		};
		// Resumed at t=500s: 60s remaining => new deadline 560s, clock running again.
		expect(resumeCountdown(paused, 500_000)).toEqual({
			deadline_at: 560_000,
			paused_at: null,
			remaining_ms: null,
		});
	});

	it("extend pushes the deadline out while running", () => {
		expect(extendCountdown(running(), 30_000)).toEqual({
			deadline_at: 130_000,
		});
	});

	it("extend adds to the frozen remaining while paused", () => {
		const paused: Countdown = {
			opened_at: 0,
			deadline_at: 100_000,
			paused_at: 40_000,
			remaining_ms: 60_000,
		};
		expect(extendCountdown(paused, 30_000)).toEqual({ remaining_ms: 90_000 });
	});

	it("the alarm arms at the deadline while running, never while paused", () => {
		expect(countdownExpiryAt(running())).toBe(100_000);
		expect(
			countdownExpiryAt({
				...running(),
				paused_at: 40_000,
				remaining_ms: 60_000,
			}),
		).toBeNull();
	});
});

describe("reprojectAcrossPause (#40 pause-everything — the freeze steals no time)", () => {
	it("shifts a running countdown's deadline by the paused duration", () => {
		const running: Countdown = { opened_at: 0, deadline_at: 1000 };
		// Remaining before pause, measured at t=600, is 400ms.
		const pausedMs = 5000;
		const shifted = reprojectAcrossPause(running, pausedMs);
		expect(shifted).toEqual({ deadline_at: 6000 });
		// The paused wall-clock time is fully added back: remaining at resume
		// (t=600+5000=5600) is 6000-5600 = 400 — identical to before the pause.
		expect(6000 - 5600).toBe(1000 - 600);
	});

	it("leaves an already-paused countdown untouched (its clock is already frozen)", () => {
		const paused: Countdown = {
			opened_at: 0,
			deadline_at: 1000,
			paused_at: 600,
			remaining_ms: 400,
		};
		expect(reprojectAcrossPause(paused, 5000)).toBeNull();
	});

	it("is a no-op shift when no time elapsed under pause", () => {
		const running: Countdown = { opened_at: 0, deadline_at: 1000 };
		expect(reprojectAcrossPause(running, 0)).toEqual({ deadline_at: 1000 });
	});
});

describe("formatRemaining (today view display)", () => {
	it("clamps zero and negative to 0s", () => {
		expect(formatRemaining(0)).toBe("0s");
		expect(formatRemaining(-5_000)).toBe("0s");
	});

	it("shows sub-minute spans in seconds (sub-second floors to whole seconds)", () => {
		expect(formatRemaining(45_000)).toBe("45s");
		expect(formatRemaining(500)).toBe("0s");
	});

	it("shows minutes with trailing seconds", () => {
		expect(formatRemaining(90_000)).toBe("1m 30s");
	});

	it("shows hours with trailing minutes (dropping seconds)", () => {
		expect(formatRemaining(3_600_000)).toBe("1h 0m");
		expect(formatRemaining(3_720_000)).toBe("1h 2m");
	});

	it("shows days with trailing hours for long deadlines", () => {
		// 25h == 1d 1h
		expect(formatRemaining(90_000_000)).toBe("1d 1h");
		// exactly one day
		expect(formatRemaining(86_400_000)).toBe("1d 0h");
	});
});

describe("formatElapsed (today view stopwatch count-up display, #90)", () => {
	it("clamps zero and negative to 0s (a close backdated before its open)", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(-5_000)).toBe("0s");
	});

	it("shows a running session's seconds, then minutes, then hours", () => {
		expect(formatElapsed(45_000)).toBe("45s");
		expect(formatElapsed(90_000)).toBe("1m 30s");
		expect(formatElapsed(3_720_000)).toBe("1h 2m");
	});

	it("coarsens a long-running session to days and hours", () => {
		expect(formatElapsed(90_000_000)).toBe("1d 1h");
	});
});

describe("durationToMs (#95 — assign form deadline entry in a chosen unit)", () => {
	it("converts minutes, hours, and days to milliseconds", () => {
		expect(durationToMs(30, "minutes")).toBe(30 * MIN);
		expect(durationToMs(2, "hours")).toBe(2 * HOUR);
		expect(durationToMs(3, "days")).toBe(3 * DAY);
	});

	it("rounds a fractional value to a whole millisecond", () => {
		// 1.5 minutes is a whole ms; a value that lands sub-ms rounds.
		expect(durationToMs(1.5, "minutes")).toBe(90_000);
		expect(durationToMs(0.0000005, "minutes")).toBe(
			Math.round(0.0000005 * MIN),
		);
	});

	it("falls back to minutes for an unknown unit rather than producing NaN", () => {
		// The unit comes from a select, but a defensive fallback keeps a stray
		// value from routing NaN as a deadline.
		expect(durationToMs(5, "weeks" as never)).toBe(5 * MIN);
	});
});

describe("extendChoicesFor (#95 — extend options scaled to the countdown)", () => {
	it("offers short bumps for a short countdown", () => {
		// A half-hour countdown: +10m and +1h are the sensible grants.
		expect(extendChoicesFor(30 * MIN).map((c) => c.label)).toEqual([
			"+10m",
			"+1h",
		]);
	});

	it("widens the window as the countdown grows", () => {
		expect(extendChoicesFor(2 * HOUR).map((c) => c.label)).toEqual([
			"+10m",
			"+1h",
			"+6h",
		]);
		expect(extendChoicesFor(12 * HOUR).map((c) => c.label)).toEqual([
			"+1h",
			"+6h",
			"+1d",
		]);
	});

	it("drops the useless +10m against a multi-day countdown", () => {
		const labels = extendChoicesFor(3 * DAY).map((c) => c.label);
		expect(labels).toEqual(["+6h", "+1d"]);
		expect(labels).not.toContain("+10m");
	});

	it("still offers at least two options for a near-zero remaining", () => {
		expect(extendChoicesFor(0).map((c) => c.label)).toEqual(["+10m", "+1h"]);
	});

	it("carries the millisecond grant matching each label", () => {
		const choices = extendChoicesFor(2 * HOUR);
		expect(choices).toEqual([
			{ label: "+10m", ms: 10 * MIN },
			{ label: "+1h", ms: HOUR },
			{ label: "+6h", ms: 6 * HOUR },
		]);
	});
});
