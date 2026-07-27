import { Link } from "@tanstack/react-router";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { awaitingMyRuling } from "#/shared/notifications.ts";
import type { Role } from "#/shared/roles.ts";

/**
 * "2 awaiting your ruling" — handoff §8.1's entry point to the queue, on the
 * screen it asks for (#136).
 *
 * Shown only to a member with something to rule, which is gated on the type's
 * `adjudicated_by` rather than on being the dom — the same gating the queue
 * itself uses, and what handles a switch without a special case.
 *
 * There is deliberately **no sub-side counterpart**. §8.3 gives the sub a "quiet
 * 'awaiting ruling' chip" on their own log entries and says "no countdowns, no
 * anxiety mechanics"; a row on their home screen counting how many of their
 * confessions are still being judged is the thing that line declines. The chips
 * already exist in the event stream.
 */
export function QueueEntry({
	events,
	types,
	members,
	selfRole,
}: {
	events: EventView[];
	types: EventType[];
	members: RoleMember[];
	selfRole: Role | null;
}) {
	const count = awaitingMyRuling({
		events,
		types,
		members: members.map((m) => ({ member_id: m.member_id, role: m.role })),
		role: selfRole,
	});
	if (count === 0) return null;

	return (
		<Link
			to="/log"
			className="block rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm"
		>
			<span className="font-medium">
				{count === 1 ? "1 thing awaits" : `${count} things await`} your ruling
			</span>
			<span className="ml-2 text-muted-foreground">Open the queue →</span>
		</Link>
	);
}
