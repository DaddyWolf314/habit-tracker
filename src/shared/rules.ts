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
		/** A fixed tag for the opened timer. */
		tag: z.string().optional(),
		/** Route an event metadata value as the tag (e.g. `activity`). Routing, not a literal. */
		tag_from: z.string().optional(),
	}),
	z.object({
		verb: z.literal("close_timer"),
		timer: z.string(),
		match_on: matchOnSchema.optional(),
		status: z.enum(["completed", "failed"]),
		/**
		 * The counter the timer's derived duration is routed into on close (e.g.
		 * R16 → `service_minutes_week`). The duration is computed by the timer
		 * projection; the rule only says where it lands — it never computes a value.
		 */
		route_duration_to: z.string().optional(),
		/** Optional gate on the duration routing, e.g. only when `activity=service`. */
		route_when: z.record(z.string(), metadataValueSchema).optional(),
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
