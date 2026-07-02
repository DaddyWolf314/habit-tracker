import { z } from "zod";
import { metadataValueSchema } from "./roles.ts";

/**
 * Rules (handoff §4.3): `when event.type = X [AND metadata equality] → effects`.
 *
 * The condition language is deliberately dumb — equality on `type` and metadata
 * keys only. Absent key ⇒ conditional rules silently skip (load-bearing for
 * adjudication). No expressions, thresholds, or state queries in v1.
 */
export const ruleConditionSchema = z.object({
	type: z.string(),
	/** Equality conditions on composite metadata. Empty ⇒ matches on type alone. */
	metadata: z.record(z.string(), metadataValueSchema).default({}),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

/** A ref match, e.g. `timer.task_id = event.task_id`, expressed as timer→event keys. */
const matchOnSchema = z.record(z.string(), z.string());

/**
 * Effect verbs — the complete v1 set. Rules route values; they never compute
 * them. Multiple effects per rule (effects is a list).
 */
export const effectSchema = z.discriminatedUnion("verb", [
	z.object({
		verb: z.literal("increment_counter"),
		counter: z.string(),
		by: z.number().default(1),
	}),
	z.object({
		verb: z.literal("decrement_counter"),
		counter: z.string(),
		by: z.number().default(1),
	}),
	z.object({ verb: z.literal("reset_counter"), counter: z.string() }),
	z.object({ verb: z.literal("reset_anchor"), anchor: z.string() }),
	z.object({
		verb: z.literal("open_timer"),
		timer: z.string(),
		match_on: matchOnSchema.optional(),
		tag: z.string().optional(),
	}),
	z.object({
		verb: z.literal("close_timer"),
		timer: z.string(),
		match_on: matchOnSchema.optional(),
		status: z.enum(["completed", "failed"]),
	}),
	/** v1: highlighted item in the today view (handoff R18). */
	z.object({
		verb: z.literal("notify"),
		target: z.enum(["partner"]).default("partner"),
	}),
]);
export type Effect = z.infer<typeof effectSchema>;

export const ruleSchema = z.object({
	id: z.string(),
	condition: ruleConditionSchema,
	effects: z.array(effectSchema).min(1),
	enabled: z.boolean().default(true),
});
export type Rule = z.infer<typeof ruleSchema>;
