import { z } from "zod";

/**
 * Role vocabulary. Custom labels are a product concern (settings); the
 * mechanical model only cares about these three permission buckets.
 */
export const roleSchema = z.enum(["dom", "sub", "switch"]);
export type Role = z.infer<typeof roleSchema>;

/** Drives display and the (deferred) scoring layer; overridable per rule effect. */
export const valenceSchema = z.enum(["positive", "negative", "neutral"]);
export type Valence = z.infer<typeof valenceSchema>;

/**
 * The three-level visibility gradient carried by a journal entry (ADR 0001).
 * A privacy/credit dial the rest of the log deliberately lacks:
 *  - `shared` — the partner sees the entry and its prose (the default for every
 *    non-journaling event, which is always shared);
 *  - `sealed` — the partner sees *that* an entry exists (it can close an
 *    assignment and drive a projection) but never the prose;
 *  - `secret` — the partner cannot tell the entry exists at all; consequently a
 *    secret entry is inert (fires no rules, touches no shared projection or trace).
 *
 * The ordering `secret < sealed < shared` is the credit gradient a prompt floor
 * compares against (see `journaling.ts`); the levels themselves live here, the
 * low-level enum module, so `events.ts` and `visibility.ts` share one source
 * without a cycle.
 */
export const visibilitySchema = z.enum(["shared", "sealed", "secret"]);
export type Visibility = z.infer<typeof visibilitySchema>;

/** A list of roles permitted to perform some action. */
export const permissionListSchema = z.array(roleSchema);
export type PermissionList = z.infer<typeof permissionListSchema>;

/**
 * Values a piece of event metadata may hold. Kinds are boolean | enum | number
 * | ref only — no freeform strings (prose lives in `note`). At rest an enum or
 * ref is a string, a number is a number, a boolean is a boolean.
 */
export const metadataValueSchema = z.union([
	z.boolean(),
	z.number(),
	z.string(),
]);
export type MetadataValue = z.infer<typeof metadataValueSchema>;

/**
 * Renders a metadata value for display: booleans read as yes/no, everything
 * else stringifies. The one place client and shared code agree how a stored
 * value reads, so the log chips, the queue, and the chain view can't diverge.
 */
export function formatMetaValue(value: MetadataValue): string {
	if (typeof value === "boolean") return value ? "yes" : "no";
	return String(value);
}
