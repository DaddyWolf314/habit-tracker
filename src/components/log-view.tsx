import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AnchorsPanel } from "#/components/log/anchors-panel.tsx";
import { CountersPanel } from "#/components/log/counters-panel.tsx";
import { EventStream } from "#/components/log/event-stream.tsx";
import { LogComposer } from "#/components/log/log-composer.tsx";
import { QueuePanel } from "#/components/log/queue-panel.tsx";
import {
	getRoles,
	listAnchors,
	listCounters,
	listEvents,
	listEventTypes,
	listRules,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import type { AnchorView } from "#/shared/anchors.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { Rule } from "#/shared/rules.ts";

/**
 * The Log surface (handoff §9 surface 3, plus the counters/composer it needs to
 * be usable on its own). A couple could live on Phase 2 alone: shared tallies
 * with a full, append-only history. Event types, counters, and the log are
 * loaded together and refreshed after every mutation.
 */
export function LogView() {
	const [ready, setReady] = useState(false);
	const [types, setTypes] = useState<EventType[]>([]);
	const [rules, setRules] = useState<Rule[]>([]);
	const [counters, setCounters] = useState<Counter[]>([]);
	const [anchors, setAnchors] = useState<AnchorView[]>([]);
	const [events, setEvents] = useState<EventView[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [error, setError] = useState<string | null>(null);

	const refreshLog = useCallback(async () => {
		const [{ events }, { counters }, { anchors }] = await Promise.all([
			listEvents(),
			listCounters(),
			listAnchors(),
		]);
		setEvents(events);
		setCounters(counters);
		setAnchors(anchors);
	}, []);

	const loadAll = useCallback(async () => {
		try {
			const [typeRes, ruleRes, counterRes, anchorRes, eventRes, roleRes] =
				await Promise.all([
					listEventTypes(),
					listRules(),
					listCounters(),
					listAnchors(),
					listEvents(),
					getRoles(),
				]);
			setTypes(typeRes.types);
			setRules(ruleRes.rules);
			setCounters(counterRes.counters);
			setAnchors(anchorRes.anchors);
			setEvents(eventRes.events);
			setMembers(roleRes.members);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't load the log.");
		}
	}, []);

	useEffect(() => {
		setReady(true);
		if (hasIdentity()) loadAll();
	}, [loadAll]);

	const self = members.find((m) => m.is_self);
	const selfRole = self?.role ?? null;

	if (!ready) return null;
	if (!hasIdentity()) {
		return (
			<div className="mx-auto max-w-2xl p-8">
				<p className="text-muted-foreground">
					You don't have a space on this device yet.{" "}
					<Link to="/" className="underline">
						Go back
					</Link>
					.
				</p>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-2xl space-y-4 p-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">Log</h1>
				<Link to="/" className="text-sm underline">
					Back
				</Link>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<QueuePanel
				events={events}
				types={types}
				rules={rules}
				members={members}
				anchors={anchors}
				selfRole={selfRole}
				onAmended={refreshLog}
			/>
			<AnchorsPanel anchors={anchors} />
			<CountersPanel counters={counters} onChange={refreshLog} />
			<LogComposer types={types} members={members} onLogged={refreshLog} />
			<EventStream
				events={events}
				types={types}
				members={members}
				selfId={self?.member_id ?? null}
				onAmended={refreshLog}
			/>
		</div>
	);
}
