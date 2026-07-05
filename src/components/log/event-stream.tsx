import { useState } from "react";
import { getEventTrace } from "#/lib/api.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { TraceRow } from "#/shared/trace.ts";
import {
	describeTraceRow,
	formatMetaValue,
	formatTime,
	memberLabel,
} from "./formatting.ts";

/**
 * The event stream (handoff §4.6, §9 surface 3): the append-only log in reverse
 * chronological order. Each entry renders its composite state (original overlaid
 * by amendments — identical to the original until Phase 5), a pending chip when
 * an `awaiting` key is unset, both timestamps, and a tap-to-open trace chain of
 * the projections it touched.
 */
export function EventStream({
	events,
	types,
	members,
}: {
	events: EventView[];
	types: EventType[];
	members: RoleMember[];
}) {
	const typeMap = new Map(types.map((t) => [t.id, t]));

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Log</h2>
			<ul className="mt-3 divide-y">
				{events.length === 0 && (
					<li className="py-3 text-sm text-muted-foreground">
						Nothing logged yet.
					</li>
				)}
				{events.map((event) => (
					<EventRow
						key={event.id}
						event={event}
						label={typeMap.get(event.type)?.label ?? event.type}
						members={members}
					/>
				))}
			</ul>
		</section>
	);
}

function EventRow({
	event,
	label,
	members,
}: {
	event: EventView;
	label: string;
	members: RoleMember[];
}) {
	const [trace, setTrace] = useState<TraceRow[] | null>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function toggle() {
		if (open) {
			setOpen(false);
			return;
		}
		setOpen(true);
		if (trace !== null) return;
		try {
			setError(null);
			setTrace((await getEventTrace(event.id)).rows);
		} catch (err) {
			// Leave trace null so tapping again retries rather than sticking.
			setError(err instanceof Error ? err.message : "Couldn't load the chain.");
		}
	}

	const meta = Object.entries(event.composite_metadata);

	return (
		<li className="py-3">
			<button
				type="button"
				className="flex w-full items-start justify-between gap-3 text-left"
				onClick={toggle}
			>
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-sm font-medium">
						{label}
						{event.pending && (
							<span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
								awaiting ruling
							</span>
						)}
					</div>
					<div className="text-xs text-muted-foreground">
						{memberLabel(event.actor, members)}
						{event.subject && (
							<> · about {memberLabel(event.subject, members)}</>
						)}
					</div>
					{meta.length > 0 && (
						<div className="mt-1 flex flex-wrap gap-1">
							{meta.map(([key, value]) => (
								<span
									key={key}
									className="rounded bg-muted px-1.5 py-0.5 text-xs"
								>
									{key}: {formatMetaValue(value)}
								</span>
							))}
						</div>
					)}
					{event.note && (
						<p className="mt-1 text-xs italic text-muted-foreground">
							“{event.note}”
						</p>
					)}
				</div>
				<div className="shrink-0 text-right text-xs text-muted-foreground">
					<div>{formatTime(event.occurred_at)}</div>
					{event.occurred_at !== event.logged_at && (
						<div>logged {formatTime(event.logged_at)}</div>
					)}
				</div>
			</button>

			{open && (
				<div className="mt-2 rounded-md border bg-muted/40 p-3">
					<p className="text-xs font-medium text-muted-foreground">
						Effects &amp; near-misses
					</p>
					<ol className="mt-1 space-y-1 text-xs text-muted-foreground">
						{error && (
							<li className="text-destructive">{error} Tap to retry.</li>
						)}
						{!error && trace === null && <li>Loading…</li>}
						{trace?.length === 0 && (
							<li>No effects — this event touched no projections.</li>
						)}
						{trace?.map((row) => {
							const line = describeTraceRow(row);
							return (
								<li
									key={row.id}
									className={line.nearMiss ? "italic opacity-70" : undefined}
								>
									{line.nearMiss ? "○ " : "• "}
									{line.text}
								</li>
							);
						})}
					</ol>
				</div>
			)}
		</li>
	);
}
