import type { RoleMember } from "#/shared/identity.ts";
import type { MetadataValue } from "#/shared/roles.ts";
import type { TraceRow } from "#/shared/trace.ts";

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

/** A trace row rendered for the chain view (handoff §4.6). */
export interface TraceLine {
	/** Human sentence: what the row did, or why a rule didn't fire. */
	text: string;
	/** Near-misses (a rule that matched on type but is waiting on a key) read differently. */
	nearMiss: boolean;
}

/**
 * Describes one trace row for the chain view: the projection it touched and the
 * change, or — for a near-miss — the rule that didn't fire and what it waits on
 * (handoff §4.6). Rules attribute their effects; direct manipulation does not.
 */
export function describeTraceRow(row: TraceRow): TraceLine {
	const detail = (row.detail ? JSON.parse(row.detail) : {}) as {
		near_miss?: boolean;
		reason?: string;
		verb?: string;
		from?: number;
		to?: number;
		target?: string;
	};
	if (detail.near_miss) {
		return {
			text: detail.reason ?? `${row.caused_by_rule} didn't fire`,
			nearMiss: true,
		};
	}
	const prefix = row.caused_by_rule ? `${row.caused_by_rule} · ` : "";
	const where = row.projection ?? "projection";
	switch (detail.verb) {
		case "reset_counter":
			return { text: `${prefix}${where}: reset → 0`, nearMiss: false };
		case "reset_anchor":
			return { text: `${prefix}${where}: anchor reset`, nearMiss: false };
		case "open_timer":
			return { text: `${prefix}${where}: timer opened`, nearMiss: false };
		case "close_timer":
			return { text: `${prefix}${where}: timer closed`, nearMiss: false };
		case "notify":
			return {
				text: `${prefix}notify ${detail.target ?? "partner"}`,
				nearMiss: false,
			};
		default:
			return {
				text: `${prefix}${where}: ${detail.from} → ${detail.to}`,
				nearMiss: false,
			};
	}
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
