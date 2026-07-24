import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AnchorsPanel } from "#/components/log/anchors-panel.tsx";
import { CountersPanel } from "#/components/log/counters-panel.tsx";
import { EventStream } from "#/components/log/event-stream.tsx";
import { LogComposer } from "#/components/log/log-composer.tsx";
import { QueuePanel } from "#/components/log/queue-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Sheet, SheetContent, SheetTrigger } from "#/components/ui/sheet.tsx";
import {
	getRoles,
	listAnchors,
	listCounters,
	listEvents,
	listEventTypes,
	listOpenPrompts,
	listRuleHistory,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import { LIVE_REFRESH_MS, useLiveRefresh } from "#/lib/use-live-refresh.ts";
import type { AnchorView } from "#/shared/anchors.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { OpenPromptView } from "#/shared/journaling.ts";
import type { VersionedRule } from "#/shared/rules.ts";

/**
 * The Log surface (handoff §9 surface 3, plus the counters/composer it needs to
 * be usable on its own). A couple could live on Phase 2 alone: shared tallies
 * with a full, append-only history. Event types, counters, and the log are
 * loaded together and refreshed after every mutation.
 *
 * The stream gets the page: the composer opens as a sheet off a floating button
 * and the counters fold behind a summary row (#91), so this reads as a log. It
 * also stays live — a low-frequency poll plus a foreground refetch (#92) — so a
 * partner's event or an incoming ruling arrives without a manual reload.
 */
export function LogView() {
	const [ready, setReady] = useState(false);
	const [types, setTypes] = useState<EventType[]>([]);
	// Versioned, not flat: the queue resolves the version in force at each
	// event's log-time (ADR 0002), exactly as the DO will on commit.
	const [rules, setRules] = useState<VersionedRule[]>([]);
	const [counters, setCounters] = useState<Counter[]>([]);
	const [anchors, setAnchors] = useState<AnchorView[]>([]);
	const [events, setEvents] = useState<EventView[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [openPrompts, setOpenPrompts] = useState<OpenPromptView[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [composerOpen, setComposerOpen] = useState(false);

	// Re-list the mutable surfaces (the type/rule definitions don't change under
	// the viewer, so loadAll owns those). Throws on failure — the two callers
	// below decide whether a failure is loud or quiet.
	const refresh = useCallback(async () => {
		const [{ events }, { counters }, { anchors }, { prompts }] =
			await Promise.all([
				listEvents(),
				listCounters(),
				listAnchors(),
				listOpenPrompts(),
			]);
		setEvents(events);
		setCounters(counters);
		setAnchors(anchors);
		setOpenPrompts(prompts);
	}, []);

	// Children fire this un-awaited after a mutation commits, so it must never
	// reject: a failed refetch has to surface here — otherwise the panels keep
	// their pre-mutation state (a ruled card still "awaiting", a stale count)
	// with nothing on screen saying why.
	const refreshLog = useCallback(async () => {
		try {
			await refresh();
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't refresh the log.",
			);
		}
	}, [refresh]);

	// The Log had no live path before (#92): loaded once, refetched only after
	// the viewer's own mutations, so a partner's event or an incoming ruling —
	// the sub's emotionally load-bearing reveal — never arrived until a manual
	// reload. Poll on the same cadence as Today, plus on foreground.
	useLiveRefresh(refresh, {
		intervalMs: LIVE_REFRESH_MS,
		enabled: ready && hasIdentity(),
	});

	const loadAll = useCallback(async () => {
		try {
			const [
				typeRes,
				ruleRes,
				counterRes,
				anchorRes,
				eventRes,
				roleRes,
				promptRes,
			] = await Promise.all([
				listEventTypes(),
				listRuleHistory(),
				listCounters(),
				listAnchors(),
				listEvents(),
				getRoles(),
				listOpenPrompts(),
			]);
			setTypes(typeRes.types);
			setRules(ruleRes.rules);
			setCounters(counterRes.counters);
			setAnchors(anchorRes.anchors);
			setEvents(eventRes.events);
			setMembers(roleRes.members);
			setOpenPrompts(promptRes.prompts);
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
		// Bottom padding leaves room for the floating compose button so it never
		// covers the last events in the stream.
		<div className="mx-auto max-w-2xl space-y-4 p-6 pb-28">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">Log</h1>
				<Link to="/" className="text-sm underline">
					Back
				</Link>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			{/* Queue stays top-of-page: for the dom it is the actionable part (#91). */}
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

			{/* Counters collapse behind a summary row so the surface reads as a log,
			    not a dashboard — the stream below gets the page (#91). */}
			<CountersSummary counters={counters} onChange={refreshLog} />

			<EventStream
				events={events}
				types={types}
				members={members}
				selfId={self?.member_id ?? null}
				onAmended={refreshLog}
			/>

			{/* The primary write action floats over the stream and opens the composer
			    as a sheet (handoff §9.4), instead of sitting buried mid-scroll. */}
			<Sheet open={composerOpen} onOpenChange={setComposerOpen}>
				<SheetTrigger asChild>
					<Button className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 shadow-lg">
						Log an event
					</Button>
				</SheetTrigger>
				<SheetContent title="Log an event">
					<LogComposer
						types={types}
						members={members}
						openPrompts={openPrompts}
						onLogged={() => {
							refreshLog();
							setComposerOpen(false);
						}}
					/>
				</SheetContent>
			</Sheet>
		</div>
	);
}

/**
 * Counters, collapsed to a one-line summary by default (#91). Clocks moved to
 * Today (#88) and the composer moved to a sheet, so the counters were the last
 * panel keeping the Log from reading as a log; here they fold behind a row that
 * still shows the live values at a glance and expands to the full editor.
 */
function CountersSummary({
	counters,
	onChange,
}: {
	counters: Counter[];
	onChange: () => void;
}) {
	const [open, setOpen] = useState(false);

	if (open) {
		return (
			<div className="space-y-2">
				<div className="flex justify-end">
					<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
						Collapse counters
					</Button>
				</div>
				<CountersPanel counters={counters} onChange={onChange} />
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setOpen(true)}
			className="flex w-full items-center justify-between gap-3 rounded-lg border p-4 text-left hover:bg-accent/50"
		>
			<span className="text-lg font-semibold">Counters</span>
			<span className="min-w-0 truncate text-sm text-muted-foreground">
				{counters.length === 0 ? "none yet" : summarizeCounters(counters)} ›
			</span>
		</button>
	);
}

/** A compact "name value" preview of the first few counters for the summary row. */
function summarizeCounters(counters: Counter[]): string {
	const shown = counters.slice(0, 3).map((c) => `${c.name} ${c.value}`);
	const extra = counters.length - shown.length;
	return extra > 0 ? `${shown.join(" · ")} +${extra} more` : shown.join(" · ");
}
