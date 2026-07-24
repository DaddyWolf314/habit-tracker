import { describe, expect, it } from "vitest";
import type { EffectOp } from "./engine.ts";
import {
	amendmentCause,
	causeColumns,
	causeFromColumns,
	decodeDetail,
	decodeTraceRow,
	describeTraceRow,
	directCause,
	domCommandCause,
	encodeDetail,
	phraseCounter,
	ruleCause,
	summarizeEffectOp,
	systemJobCause,
	type TraceCause,
	type TraceDetail,
	type TraceRowColumns,
	traceAnchor,
	traceAutoClose,
	traceCounter,
	traceNearMiss,
	traceScheduledReset,
	traceStreakRollover,
	traceTimerClose,
	traceTimerCommand,
	traceTimerOpen,
} from "./trace.ts";

// A representative value of every detail kind — the round-trip contract.
const ALL_DETAILS: TraceDetail[] = [
	{ kind: "counter", op: "increment", by: 2, from: 3, to: 5 },
	{ kind: "counter", op: "reset", from: 4, to: 0 },
	{ kind: "anchor", at: 1_000, from: null, to: 1_000 },
	{
		kind: "timer_open",
		timer_id: "t1",
		match_on: { session_id: "s1" },
		tag: "service",
	},
	{
		kind: "timer_close",
		matched: true,
		timer_id: "t1",
		status: "completed",
		duration_ms: 60_000,
	},
	{
		kind: "timer_close",
		matched: false,
		match_on: {},
		note: "no matching open timer",
	},
	{
		kind: "timer_skipped",
		reason: "R14 skipped: denial_period already ended",
		op: "close",
	},
	{ kind: "notify", target: "partner" },
	{
		kind: "near_miss",
		reason: "R12 didn't fire: permitted not set",
		awaiting: ["permitted"],
	},
	{
		kind: "auto_close",
		reason: "over_max",
		flagged_for_review: true,
		timer_id: "t2",
		duration_ms: 99,
	},
	{ kind: "expire", reason: "past_deadline", timer_id: "t3" },
	{
		kind: "streak_rollover",
		period: "daily",
		target_counter: "rituals_completed_today",
		met: true,
		from: 4,
		to: 5,
	},
	{ kind: "scheduled_reset", period: "weekly", from: 12, to: 0 },
	{
		kind: "timer_command",
		command: "extend",
		timer_id: "t4",
		deadline_at: 5_000,
		by_ms: 60_000,
	},
	{
		kind: "timer_command",
		command: "cancel",
		timer_id: "t5",
	},
];

describe("detail codec (JSON string at rest, typed at the read model)", () => {
	it("round-trips every detail kind through encode → decode", () => {
		for (const detail of ALL_DETAILS) {
			expect(decodeDetail(encodeDetail(detail))).toEqual(detail);
		}
	});

	it("degrades to { kind: 'unknown' } on a null column (never throws)", () => {
		expect(decodeDetail(null)).toEqual({ kind: "unknown" });
	});

	it("degrades to { kind: 'unknown' } on unparseable JSON", () => {
		expect(decodeDetail("{not json")).toEqual({ kind: "unknown" });
	});

	it("degrades to { kind: 'unknown' } on a shape outside the union (e.g. legacy)", () => {
		// A legacy verb-based row from before the ledger — read, not crash.
		expect(
			decodeDetail(JSON.stringify({ verb: "reset_counter", from: 3, to: 0 })),
		).toEqual({
			kind: "unknown",
		});
	});
});

describe("cause ⇄ columns (the sentinel overload is gone)", () => {
	const cases: TraceCause[] = [
		ruleCause("e1", "R1"),
		directCause("e2"),
		amendmentCause("e3", "R12", "a1"),
		systemJobCause(),
		domCommandCause("m1"),
	];

	it("round-trips every cause through columns", () => {
		for (const cause of cases) {
			expect(causeFromColumns(causeColumns(cause))).toEqual(cause);
		}
	});

	it("never writes a sentinel into caused_by_rule", () => {
		// system_job / dom_command carry NO rule id — they are told apart by the
		// actor column, not by a magic string in caused_by_rule.
		expect(causeColumns(systemJobCause()).caused_by_rule).toBeNull();
		expect(causeColumns(domCommandCause("m1")).caused_by_rule).toBeNull();
		expect(causeColumns(domCommandCause("m1")).actor).toBe("m1");
	});

	it("distinguishes system_job from a bare direct cause", () => {
		// Both have a null rule; a direct cause has an event, a system job does not.
		expect(causeFromColumns(causeColumns(directCause("e2"))).by).toBe("direct");
		expect(causeFromColumns(causeColumns(systemJobCause())).by).toBe(
			"system_job",
		);
	});
});

describe("decodeTraceRow (the RPC boundary)", () => {
	it("reconstructs a rule-caused counter row from stored columns", () => {
		const cols: TraceRowColumns = {
			id: 7,
			at: 1_234,
			caused_by_event: "e1",
			caused_by_rule: "R11",
			caused_by_amendment: null,
			actor: null,
			projection: "counter:orgasms_permitted",
			detail: encodeDetail({
				kind: "counter",
				op: "increment",
				by: 1,
				from: 0,
				to: 1,
			}),
		};
		expect(decodeTraceRow(cols)).toEqual({
			id: 7,
			at: 1_234,
			cause: { by: "rule", event: "e1", rule: "R11" },
			projection: "counter:orgasms_permitted",
			detail: { kind: "counter", op: "increment", by: 1, from: 0, to: 1 },
		});
	});

	it("reconstructs an amendment-caused row (amendment id from its own column)", () => {
		const cols: TraceRowColumns = {
			id: 8,
			at: 2_000,
			caused_by_event: "e1",
			caused_by_rule: "R12",
			caused_by_amendment: "am1",
			actor: null,
			projection: "counter:demerits",
			detail: encodeDetail({
				kind: "counter",
				op: "increment",
				by: 2,
				from: 0,
				to: 2,
			}),
		};
		expect(decodeTraceRow(cols).cause).toEqual({
			by: "amendment",
			event: "e1",
			rule: "R12",
			amendment: "am1",
		});
	});
});

describe("builders (pure; one sink writes them)", () => {
	it("traceCounter targets counter:<id> and carries the change", () => {
		expect(
			traceCounter(ruleCause("e1", "R1"), 100, "demerits", {
				op: "increment",
				by: 2,
				from: 1,
				to: 3,
			}),
		).toEqual({
			cause: { by: "rule", event: "e1", rule: "R1" },
			at: 100,
			projection: "counter:demerits",
			detail: { kind: "counter", op: "increment", by: 2, from: 1, to: 3 },
		});
	});

	it("traceNearMiss has a null projection (it touched nothing)", () => {
		const e = traceNearMiss(ruleCause("e1", "R12"), 50, {
			reason: "…",
			awaiting: ["permitted"],
		});
		expect(e.projection).toBeNull();
		expect(e.detail.kind).toBe("near_miss");
	});

	it("system-job builders own their cause", () => {
		expect(
			traceAutoClose(9, "session_stopwatch", {
				flagged_for_review: true,
				timer_id: "t",
				duration_ms: 1,
			}).cause,
		).toEqual(systemJobCause());
		expect(
			traceStreakRollover(9, "streak", {
				period: "daily",
				target_counter: "c",
				met: false,
				from: 3,
				to: 0,
			}).cause.by,
		).toBe("system_job");
		expect(
			traceScheduledReset(9, "c", { period: "weekly", from: 5, to: 0 }).cause
				.by,
		).toBe("system_job");
	});

	it("traceTimerCommand owns a dom_command cause with the actor", () => {
		expect(
			traceTimerCommand("m1", 9, "task_countdown", {
				command: "pause",
				timer_id: "t",
				remaining_ms: 10,
			}).cause,
		).toEqual(domCommandCause("m1"));
	});

	it("timer builders target timer:<def>", () => {
		expect(
			traceTimerOpen(ruleCause("e", "R15"), 1, "session_stopwatch", {
				timer_id: "t",
			}).projection,
		).toBe("timer:session_stopwatch");
		expect(
			traceTimerClose(ruleCause("e", "R16"), 1, "session_stopwatch", {
				matched: true,
			}).projection,
		).toBe("timer:session_stopwatch");
		expect(
			traceAnchor(ruleCause("e", "R7"), 1, "since_last_infraction", {
				at: 1,
				from: null,
				to: 1,
			}).projection,
		).toBe("anchor:since_last_infraction");
	});
});

describe("phraseCounter (shared by preview and chain)", () => {
	it("humanizes the id and signs the delta", () => {
		expect(phraseCounter("orgasms_unpermitted", "increment", 1)).toBe(
			"+1 orgasms unpermitted",
		);
		expect(phraseCounter("demerits", "decrement", 2)).toBe("−2 demerits");
		expect(phraseCounter("demerits", "reset")).toBe("reset demerits");
	});

	it("defaults by to 1", () => {
		expect(phraseCounter("x", "increment")).toBe("+1 x");
	});
});

describe("summarizeEffectOp (confirm-sheet preview)", () => {
	const ops: [EffectOp, string][] = [
		[
			{ kind: "counter", counter: "demerits", op: "increment", by: 2 },
			"+2 demerits",
		],
		[{ kind: "counter", counter: "demerits", op: "reset" }, "reset demerits"],
		[
			{ kind: "anchor", anchor: "since_last_orgasm", at: 0 },
			"reset since last orgasm streak",
		],
		[
			{ kind: "timer", timer: "task_countdown", op: "open" },
			"start task countdown",
		],
		[
			{ kind: "timer", timer: "denial_period", op: "close", status: "failed" },
			"mark denial period failed",
		],
		[{ kind: "notify", target: "partner" }, "notify partner"],
	];
	it("phrases every effect op", () => {
		for (const [op, expected] of ops)
			expect(summarizeEffectOp(op)).toBe(expected);
	});

	it("counter preview and counter chain read identically", () => {
		// The whole reason phraseCounter is shared: 'what will fire' === 'what fired'.
		const previewed = summarizeEffectOp({
			kind: "counter",
			counter: "demerits",
			op: "increment",
			by: 2,
		});
		const fired = describeTraceRow(
			decodeTraceRow({
				id: 1,
				at: 0,
				caused_by_event: "e",
				caused_by_rule: "R8",
				caused_by_amendment: null,
				actor: null,
				projection: "counter:demerits",
				detail: encodeDetail({
					kind: "counter",
					op: "increment",
					by: 2,
					from: 0,
					to: 2,
				}),
			}),
		).summary;
		expect(fired).toBe(`R8 · ${previewed}`);
	});
});

describe("describeTraceRow (label-free chain line)", () => {
	const row = (
		cause: TraceCause,
		projection: string | null,
		detail: TraceDetail,
	) =>
		decodeTraceRow({
			id: 1,
			at: 0,
			projection,
			detail: encodeDetail(detail),
			...causeColumns(cause),
		});

	it("prefixes rule effects with the rule id and tone 'effect'", () => {
		const line = describeTraceRow(
			row(ruleCause("e", "R2"), "counter:demerits", {
				kind: "counter",
				op: "increment",
				by: 1,
				from: 0,
				to: 1,
			}),
		);
		expect(line).toEqual({ tone: "effect", summary: "R2 · +1 demerits" });
	});

	it("direct manipulation has no rule prefix", () => {
		const line = describeTraceRow(
			row(directCause("e"), "counter:demerits", {
				kind: "counter",
				op: "increment",
				by: 1,
				from: 0,
				to: 1,
			}),
		);
		expect(line.summary).toBe("+1 demerits");
	});

	it("near-misses carry tone 'near_miss' and the reason", () => {
		const line = describeTraceRow(
			row(ruleCause("e", "R12"), null, {
				kind: "near_miss",
				reason: "R12 didn't fire: permitted not set",
				awaiting: ["permitted"],
			}),
		);
		expect(line).toEqual({
			tone: "near_miss",
			summary: "R12 didn't fire: permitted not set",
		});
	});

	it("system jobs are tone 'system'", () => {
		expect(
			describeTraceRow(
				row(systemJobCause(), "counter:rituals", {
					kind: "scheduled_reset",
					period: "daily",
					from: 3,
					to: 0,
				}),
			).tone,
		).toBe("system");
		expect(
			describeTraceRow(
				row(systemJobCause(), "timer:session_stopwatch", {
					kind: "auto_close",
					reason: "over_max",
					flagged_for_review: true,
					timer_id: "t",
					duration_ms: 1,
				}),
			).tone,
		).toBe("system");
	});

	it("dom commands are tone 'command'", () => {
		const line = describeTraceRow(
			row(domCommandCause("m1"), "timer:task_countdown", {
				kind: "timer_command",
				command: "pause",
				timer_id: "t",
				remaining_ms: 10,
			}),
		);
		expect(line).toEqual({ tone: "command", summary: "pause task countdown" });
	});

	it("an orphan timer close explains itself", () => {
		const line = describeTraceRow(
			row(ruleCause("e", "R16"), "timer:session_stopwatch", {
				kind: "timer_close",
				matched: false,
				note: "no matching open timer",
			}),
		);
		expect(line.summary).toContain("no matching timer");
		expect(line.note).toBe("no matching open timer");
	});

	it("degrades an unrecognized detail to a safe line (never throws)", () => {
		const line = describeTraceRow(
			decodeTraceRow({
				id: 1,
				at: 0,
				caused_by_event: null,
				caused_by_rule: null,
				caused_by_amendment: null,
				actor: null,
				projection: null,
				detail: "{legacy garbage",
			}),
		);
		expect(line).toEqual({ tone: "system", summary: "(unrecognized change)" });
	});
});
