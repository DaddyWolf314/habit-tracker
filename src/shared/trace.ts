import { z } from "zod";

/**
 * Trace / transparency (handoff §4.6) — every projection change records what
 * caused it: the event id and the rule id (or system job). Tapping any counter
 * or any event reconstructs the full chain: log → amendments → rules fired →
 * projections touched. The consent-record view and the debugging view are the
 * same data. In Phase 2 the only cause is a direct `counter_adjusted` /
 * `counter_reset` event (`caused_by_rule` is null); the rule pack fills that in
 * from Phase 3.
 */
export const traceRowSchema = z.object({
	id: z.number().int(),
	at: z.number().int(),
	caused_by_event: z.string().nullable(),
	caused_by_rule: z.string().nullable(),
	/** The projection touched, e.g. `counter:demerits`. */
	projection: z.string().nullable(),
	/** JSON-encoded specifics of the change (verb, delta, from → to). */
	detail: z.string().nullable(),
});
export type TraceRow = z.infer<typeof traceRowSchema>;

/** The causal chain behind one counter: its trace rows, newest first. */
export const counterTraceSchema = z.object({
	counter_id: z.string(),
	value: z.number().int(),
	rows: z.array(traceRowSchema),
});
export type CounterTrace = z.infer<typeof counterTraceSchema>;
