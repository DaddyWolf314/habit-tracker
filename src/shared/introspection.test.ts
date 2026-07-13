import { describe, expect, it } from "vitest";
import { explainProjection, introspectInputSchema } from "./introspection.ts";
import { directCause, systemJobCause, type TraceRow } from "./trace.ts";

/**
 * The support-introspection surface answers "why did this projection change"
 * (e.g. "why did this streak reset") by reconstructing the causal chain from the
 * Trace ledger — the same rows the transparency view reads, framed as an
 * explanation. `explainProjection` is the pure core; the DO wraps it with the
 * audit-log write that makes every access non-silent.
 */

const resetRow: TraceRow = {
	id: 3,
	at: 3000,
	cause: systemJobCause(),
	projection: "counter:ritual_streak_days",
	detail: { kind: "scheduled_reset", period: "daily", from: 5, to: 0 },
};

const incrementRow: TraceRow = {
	id: 2,
	at: 2000,
	cause: directCause("evt-1"),
	projection: "counter:ritual_streak_days",
	detail: { kind: "counter", op: "increment", by: 1, from: 4, to: 5 },
};

describe("explainProjection", () => {
	it("headlines the most recent change and lists the full chain newest-first", () => {
		const explanation = explainProjection("counter:ritual_streak_days", [
			resetRow,
			incrementRow,
		]);
		expect(explanation.projection).toBe("counter:ritual_streak_days");
		// The newest row (the reset) is the answer to "why did it reset".
		expect(explanation.headline).toBe("ritual streak days reset (daily)");
		expect(explanation.chain).toHaveLength(2);
		expect(explanation.chain[0]).toMatchObject({
			id: 3,
			at: 3000,
			tone: "system",
			summary: "ritual streak days reset (daily)",
		});
		expect(explanation.chain[1]).toMatchObject({
			id: 2,
			at: 2000,
			tone: "effect",
		});
	});

	it("carries a chain line's optional note through", () => {
		const noted: TraceRow = {
			id: 4,
			at: 4000,
			cause: directCause("evt-2"),
			projection: "timer:session",
			detail: {
				kind: "timer_close",
				matched: false,
				note: "no open timer",
			},
		};
		const [line] = explainProjection("timer:session", [noted]).chain;
		expect(line.note).toBe("no open timer");
	});

	it("degrades to a no-history headline and empty chain when nothing is recorded", () => {
		const explanation = explainProjection("counter:unknown", []);
		expect(explanation.chain).toEqual([]);
		expect(explanation.headline).toBe(
			"No recorded changes for counter:unknown.",
		);
	});
});

describe("introspectInputSchema", () => {
	it("requires a non-empty projection key", () => {
		expect(
			introspectInputSchema.safeParse({ projection: "counter:x" }).success,
		).toBe(true);
		expect(introspectInputSchema.safeParse({ projection: "" }).success).toBe(
			false,
		);
		expect(introspectInputSchema.safeParse({}).success).toBe(false);
	});
});
