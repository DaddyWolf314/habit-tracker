import { z } from "zod";
import { permissionListSchema, valenceSchema } from "./roles.ts";

/**
 * Counters (handoff §4.4) — materialized tallies derived from the event log.
 * The stored value is a *cache* for cheap reads and live sync; it is always
 * rebuildable by replaying the log (see `projections.ts`). In Phase 2 the only
 * thing that moves a counter is direct manipulation (`counter_adjusted` /
 * `counter_reset` events); the rule pack that drives them from real events
 * lands in Phase 3.
 */

/**
 * Reset semantics, a first-class counter property (handoff §4.4):
 *  - `never`            — accumulates forever (lifetime tallies).
 *  - `daily` / `weekly` — cleared on a schedule; the firing alarm is Phase 4,
 *    so in Phase 2 the cadence is stored but only event-driven resets apply.
 *  - `on_acknowledgment`— cleared when acknowledged (a `counter_reset` event).
 *  - `manual`           — cleared by hand, with a note (a `counter_reset` event).
 */
export const counterResetSchema = z.enum([
	"never",
	"daily",
	"weekly",
	"on_acknowledgment",
	"manual",
]);
export type CounterReset = z.infer<typeof counterResetSchema>;

/** The stored definition of a counter (its identity and policy, not its value). */
export const counterDefinitionSchema = z.object({
	id: z.string(),
	name: z.string().min(1),
	valence: valenceSchema.default("neutral"),
	daily_target: z.number().int().positive().optional(),
	weekly_target: z.number().int().positive().optional(),
	reset: counterResetSchema.default("never"),
	/** Roles permitted to adjust or reset the counter directly (handoff §4.4). */
	modify_permission: permissionListSchema.default(["dom", "sub", "switch"]),
});
export type CounterDefinition = z.infer<typeof counterDefinitionSchema>;

/** What a client sends to create a counter; the id is derived from the name. */
export const createCounterInputSchema = counterDefinitionSchema
	.omit({ id: true })
	.extend({ id: z.string().optional() });
/** Parsed shape (defaults applied) — what the DO receives. */
export type CreateCounterInput = z.infer<typeof createCounterInputSchema>;
/** Wire shape (defaults optional) — what a client may send. */
export type CreateCounterBody = z.input<typeof createCounterInputSchema>;

/** A counter as returned to clients: its definition plus the cached value. */
export const counterSchema = counterDefinitionSchema.extend({
	value: z.number().int(),
	updated_at: z.number().int().nullable(),
});
export type Counter = z.infer<typeof counterSchema>;

/** Payload for a direct +N / −N adjustment (the "+1 tap" sugar). */
export const adjustCounterInputSchema = z.object({
	delta: z.number().int(),
	note: z.string().max(500).optional(),
});
export type AdjustCounterInput = z.infer<typeof adjustCounterInputSchema>;

/** Payload for a manual/acknowledgment reset. */
export const resetCounterInputSchema = z.object({
	note: z.string().max(500).optional(),
});
export type ResetCounterInput = z.infer<typeof resetCounterInputSchema>;
