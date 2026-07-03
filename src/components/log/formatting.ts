import type { RoleMember } from "#/shared/identity.ts";
import type { MetadataValue } from "#/shared/roles.ts";

/** A short absolute timestamp for the log ("Jul 2, 11:03 PM"). */
export function formatTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** Coarse "waiting 9h" style elapsed label for pending events (handoff §8). */
export function formatElapsed(sinceMs: number, nowMs: number): string {
	const mins = Math.max(0, Math.floor((nowMs - sinceMs) / 60000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Renders a metadata value for display (booleans as yes/no). */
export function formatMetaValue(value: MetadataValue): string {
	if (typeof value === "boolean") return value ? "yes" : "no";
	return String(value);
}

/** Maps a member id to a readable label using the role roster. */
export function memberLabel(
	id: string | undefined,
	members: RoleMember[],
): string {
	if (!id) return "—";
	const member = members.find((m) => m.member_id === id);
	if (!member) return id.slice(0, 6);
	const role = member.role ? member.role : "partner";
	return member.is_self ? `you (${role})` : role;
}
