import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CountersPanel } from "#/components/log/counters-panel.tsx";
import { EventStream } from "#/components/log/event-stream.tsx";
import { LogComposer } from "#/components/log/log-composer.tsx";
import {
	getRoles,
	listCounters,
	listEvents,
	listEventTypes,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";

/**
 * The Log surface (handoff §9 surface 3, plus the counters/composer it needs to
 * be usable on its own). A couple could live on Phase 2 alone: shared tallies
 * with a full, append-only history. Event types, counters, and the log are
 * loaded together and refreshed after every mutation.
 */
export function LogView() {
	const [ready, setReady] = useState(false);
	const [types, setTypes] = useState<EventType[]>([]);
	const [counters, setCounters] = useState<Counter[]>([]);
	const [events, setEvents] = useState<EventView[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [error, setError] = useState<string | null>(null);

	const refreshLog = useCallback(async () => {
		const [{ events }, { counters }] = await Promise.all([
			listEvents(),
			listCounters(),
		]);
		setEvents(events);
		setCounters(counters);
	}, []);

	const loadAll = useCallback(async () => {
		try {
			const [typeRes, counterRes, eventRes, roleRes] = await Promise.all([
				listEventTypes(),
				listCounters(),
				listEvents(),
				getRoles(),
			]);
			setTypes(typeRes.types);
			setCounters(counterRes.counters);
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

			<CountersPanel counters={counters} onChange={refreshLog} />
			<LogComposer types={types} members={members} onLogged={refreshLog} />
			<EventStream events={events} types={types} members={members} />
		</div>
	);
}
