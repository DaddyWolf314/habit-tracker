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
