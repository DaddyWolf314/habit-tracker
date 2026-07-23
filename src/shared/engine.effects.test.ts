import { describe, expect, it } from "vitest";
import {
	applyCounterOp,
	type EffectOp,
	type RuleEventContext,
	resolveEffect,
	routeClosedTimerDuration,
} from "./engine.ts";
import type { Effect } from "./rules.ts";

function ctx(
	type: string,
	metadata: RuleEventContext["metadata"] = {},
	occurred_at = 5000,
): RuleEventContext {
	return { type, metadata, occurred_at };
}

describe("effect verb resolution (handoff §4.3)", () => {
	it("increment/decrement counter carry their `by` and target", () => {
		const inc: Effect = {
			verb: "increment_counter",
			counter: "demerits",
			by: 2,
		};
		const dec: Effect = {
			verb: "decrement_counter",
			counter: "demerits",
			by: 1,
		};
		expect(resolveEffect(inc, ctx("orgasm"))).toEqual({
			kind: "counter",
			counter: "demerits",
			op: "increment",
			by: 2,
		});
		expect(resolveEffect(dec, ctx("orgasm"))).toEqual({
			kind: "counter",
			counter: "demerits",
			op: "decrement",
			by: 1,
		});
	});

	it("reset counter targets the counter projection", () => {
		const eff: Effect = { verb: "reset_counter", counter: "demerits" };
		expect(resolveEffect(eff, ctx("infraction"))).toEqual({
			kind: "counter",
			counter: "demerits",
			op: "reset",
		});
	});

	it("reset anchor uses the event's occurred_at (time-anchored, not log time)", () => {
		const eff: Effect = {
			verb: "reset_anchor",
			anchor: "since_last_infraction",
		};
		expect(resolveEffect(eff, ctx("infraction", {}, 4242))).toEqual({
			kind: "anchor",
			anchor: "since_last_infraction",
			at: 4242,
		});
	});

	it("open timer routes a ref match and tags from an event value", () => {
		const eff: Effect = {
			verb: "open_timer",
			timer: "session_stopwatch",
			match_on: { session_id: "session_id" },
			tag_from: "activity",
		};
		expect(
			resolveEffect(
				eff,
				ctx("session_started", { session_id: "s1", activity: "service" }),
			),
		).toEqual({
			kind: "timer",
			timer: "session_stopwatch",
			op: "open",
			match_on: { session_id: "s1" },
			tag: "service",
			// No duration_from: a stopwatch carries no routed deadline.
			duration_ms: undefined,
		});
	});

	it("open timer routes a per-event duration via duration_from (countdown)", () => {
		const eff: Effect = {
			verb: "open_timer",
			timer: "task_countdown",
			match_on: { task_id: "task_id" },
			duration_from: "duration_ms",
		};
		expect(
			resolveEffect(
				eff,
				ctx("task_assigned", { task_id: "t7", duration_ms: 3_600_000 }),
			),
		).toEqual({
			kind: "timer",
			timer: "task_countdown",
			op: "open",
			match_on: { task_id: "t7" },
			tag: undefined,
			duration_ms: 3_600_000,
		});
	});

	it("open timer drops a non-numeric duration_from value (routes, never coerces)", () => {
		const eff: Effect = {
			verb: "open_timer",
			timer: "task_countdown",
			duration_from: "duration_ms",
		};
		// A string metadata value is not a duration; unlike tag_from we never
		// format it — the countdown simply gets no routed deadline.
		expect(
			resolveEffect(eff, ctx("task_assigned", { duration_ms: "soon" })),
		).toMatchObject({ duration_ms: undefined });
	});

	it("close timer carries status and the match resolved from the event", () => {
		const eff: Effect = {
			verb: "close_timer",
			timer: "task_countdown",
			match_on: { task_id: "task_id" },
			status: "completed",
		};
		expect(
			resolveEffect(eff, ctx("task_completed", { task_id: "t7" })),
		).toEqual({
			kind: "timer",
			timer: "task_countdown",
			op: "close",
			match_on: { task_id: "t7" },
			status: "completed",
			route_duration_to: undefined,
			route_when_met: undefined,
		});
	});

	it("notify targets the partner", () => {
		const eff: Effect = { verb: "notify", target: "partner" };
		expect(
			resolveEffect(eff, ctx("check_in", { flag: "wants_conversation" })),
		).toEqual({
			kind: "notify",
			target: "partner",
		});
	});
});

describe("routing derived duration into a counter (handoff §4.3, R16)", () => {
	// R16: close the session stopwatch and add its derived duration to
	// service_minutes_week — but only when activity=service.
	const r16: Effect = {
		verb: "close_timer",
		timer: "session_stopwatch",
		match_on: { session_id: "session_id" },
		status: "completed",
		route_duration_to: "service_minutes_week",
		route_when: { activity: "service" },
	};

	function closeOp(metadata: RuleEventContext["metadata"]): EffectOp {
		return resolveEffect(r16, ctx("session_ended", metadata));
	}

	it("routes the timer-computed duration into the counter (rule does not compute it)", () => {
		const op = closeOp({ session_id: "s1", activity: "service" });
		// The duration is supplied by the timer projection on close; the rule only
		// says where it lands. 37 minutes derived => +37 to service_minutes_week.
		expect(routeClosedTimerDuration(op, 37)).toEqual({
			kind: "counter",
			counter: "service_minutes_week",
			op: "increment",
			by: 37,
		});
	});

	it("does not route when the gate is unmet (activity != service)", () => {
		const op = closeOp({ session_id: "s1", activity: "kneeling" });
		expect(routeClosedTimerDuration(op, 37)).toBeNull();
	});

	it("does not route a close that has no duration target", () => {
		const plainClose = resolveEffect(
			{ verb: "close_timer", timer: "task_countdown", status: "completed" },
			ctx("task_completed", { task_id: "t1" }),
		);
		expect(routeClosedTimerDuration(plainClose, 12)).toBeNull();
	});
});

describe("applyCounterOp (shared by live apply + rebuild)", () => {
	it("folds increment/decrement (by defaults to 1) and reset", () => {
		expect(
			applyCounterOp(5, {
				kind: "counter",
				counter: "c",
				op: "increment",
				by: 2,
			}),
		).toBe(7);
		expect(
			applyCounterOp(5, { kind: "counter", counter: "c", op: "increment" }),
		).toBe(6);
		expect(
			applyCounterOp(5, {
				kind: "counter",
				counter: "c",
				op: "decrement",
				by: 3,
			}),
		).toBe(2);
		expect(
			applyCounterOp(5, { kind: "counter", counter: "c", op: "reset" }),
		).toBe(0);
	});
});
