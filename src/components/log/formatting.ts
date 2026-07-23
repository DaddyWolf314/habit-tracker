import type { RoleMember } from "#/shared/identity.ts";

// The metadata-value formatter is shared (client and DO agree how a value
// reads); re-exported here so log components keep importing it alongside the
// other display helpers.
export { formatMetaValue } from "#/shared/roles.ts";
// Trace decoding and effect phrasing live in the Trace ledger (shared) so the DO
// writes and the UI reads through one taxonomy; re-exported here so the log
// components keep importing them alongside the display helpers.
export {
	describeTraceRow,
	summarizeEffectOp,
	type TraceLine,
} from "#/shared/trace.ts";

/** A short absolute timestamp for the log ("Jul 2, 11:03 PM"). */
export function formatTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * The "days since" phrasing for an anchor (handoff §4.5, #78) — one formatter
 * for every surface: null (never reset) reads "—", 0 reads "today". `compact`
 * yields the chip form ("3d") the adjudication evidence uses.
 */
export function elapsedDaysText(days: number | null, compact = false): string {
	if (days === null) return "—";
	if (days === 0) return "today";
	if (compact) return `${days}d`;
	return days === 1 ? "1 day" : `${days} days`;
}

/** Coarse "waiting 9h" style elapsed label for pending events (handoff §8). */
export function formatElapsed(sinceMs: number, nowMs: number): string {
	const mins = Math.max(0, Math.floor((nowMs - sinceMs) / 60000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
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
