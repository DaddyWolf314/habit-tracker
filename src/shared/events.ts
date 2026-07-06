import { z } from "zod";
import { amendmentSchema } from "./amendments.ts";
import { metadataValueSchema } from "./roles.ts";

/**
 * Events — the append-only source of truth (handoff §4.1). Never mutated or
 * deleted; post-hoc changes are amendments. Rules never create events.
 *
 * Timestamps are epoch milliseconds. `occurred_at` and `logged_at` are separate
 * on purpose: backfill ("forgot to log this morning") is common, and
 * time-anchored effects use `occurred_at`.
 */
export const eventSchema = z.object({
	id: z.string(), // ULID
	type: z.string(), // references the couple's event-type schema set
	actor: z.string(), // member id who logged it
	subject: z.string().optional(), // who it's about; required per type schema
	occurred_at: z.number().int(),
	logged_at: z.number().int(),
	metadata: z.record(z.string(), metadataValueSchema).default({}),
	note: z.string().optional(),
});
export type Event = z.infer<typeof eventSchema>;

/**
 * Payload accepted from a client when logging an event. Server assigns `id` and
 * `logged_at`; `occurred_at` defaults to `logged_at` when omitted. Direct
 * manipulation (a "+1" counter tap) is sugar that emits a `counter_adjusted`
 * event — everything is an event.
 */
export const logEventInputSchema = z.object({
	type: z.string(),
	subject: z.string().optional(),
	occurred_at: z.number().int().optional(),
	metadata: z.record(z.string(), metadataValueSchema).default({}),
	note: z.string().optional(),
});
export type LogEventInput = z.infer<typeof logEventInputSchema>;

/**
 * An event as rendered in the log (handoff §4.6, §9 surface 3): the raw event
 * plus its amendments, the derived composite metadata (original overlaid by
 * amendments), and the derived `pending` status. Composite state and pending
 * are computed, never stored; in Phase 2 there are no amendments yet, so the
 * composite equals the original — the shape is here so the UI is correct as
 * amendments arrive in Phase 5.
 */
export const eventViewSchema = eventSchema.extend({
	amendments: z.array(amendmentSchema).default([]),
	composite_metadata: z.record(z.string(), metadataValueSchema).default({}),
	pending: z.boolean(),
	/**
	 * Derived: the event carries a `retracted` amendment. Never pending, and shown
	 * as withdrawn in the log — retraction is visible relationship data, not a
	 * delete (handoff §4.2).
	 */
	retracted: z.boolean().default(false),
});
export type EventView = z.infer<typeof eventViewSchema>;
