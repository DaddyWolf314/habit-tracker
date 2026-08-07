import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { CountersPanel } from "#/components/log/counters-panel.tsx";
import { EventStream } from "#/components/log/event-stream.tsx";
import { LogComposer } from "#/components/log/log-composer.tsx";
import { QueuePanel } from "#/components/log/queue-panel.tsx";
import { ABOVE_TAB_BAR } from "#/components/tab-bar.tsx";
import { Button } from "#/components/ui/button.tsx";
import { pageClass, pageRowsClass } from "#/components/ui/page.ts";
import { Sheet, SheetContent, SheetTrigger } from "#/components/ui/sheet.tsx";
import {
	getRoles,
	listAgreements,
	listAnchors,
	listCounters,
	listEvents,
	listEventTypes,
	listOpenPrompts,
	listRewardItems,
	listRuleHistory,
	listTimers,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import { LIVE_REFRESH_MS, useLiveRefresh } from "#/lib/use-live-refresh.ts";
import type { VersionedAgreement } from "#/shared/agreements.ts";
import type { AnchorView } from "#/shared/anchors.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { OpenPromptView } from "#/shared/journaling.ts";
import type { VersionedRewardItem } from "#/shared/rewards.ts";
import type { Role } from "#/shared/roles.ts";
import { currentRule, type VersionedRule } from "#/shared/rules.ts";
import type { TimerView } from "#/shared/timers.ts";

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
	// Still loaded though the clocks moved to Today (#88): the queue's confirm
	// sheet reads them to show a ruling's fallout ("reset good-behaviour streak")
	// before it commits.
	const [anchors, setAnchors] = useState<AnchorView[]>([]);
	const [events, setEvents] = useState<EventView[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [openPrompts, setOpenPrompts] = useState<OpenPromptView[]>([]);
	// The timers feed the composer's ref pickers (#89) — the candidates a
	// `session_ended`/`task_completed` can name — so they refresh with the log.
	const [timers, setTimers] = useState<TimerView[]>([]);
	const [agreements, setAgreements] = useState<VersionedAgreement[]>([]);
	// The store feeds the composer's `reward_ref` picker and the chain view's
	// price-crossing lines (#194, ADR 0017), so it refreshes with the log.
	const [rewards, setRewards] = useState<VersionedRewardItem[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [composerOpen, setComposerOpen] = useState(false);

	// Re-list the mutable surfaces (the type/rule definitions don't change under
	// the viewer, so loadAll owns those). Throws on failure — the two callers
	// below decide whether a failure is loud or quiet.
	const refresh = useCallback(async () => {
		const [
			{ events },
			{ counters },
			{ anchors },
			{ prompts },
			{ timers },
			{ agreements },
			{ rewards },
		] = await Promise.all([
			listEvents(),
			listCounters(),
			listAnchors(),
			listOpenPrompts(),
			listTimers(),
			listAgreements(),
			listRewardItems(),
		]);
		setEvents(events);
		setCounters(counters);
		setAnchors(anchors);
		setOpenPrompts(prompts);
		setTimers(timers);
		setAgreements(agreements);
		setRewards(rewards);
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
				timerRes,
				agreementRes,
				rewardRes,
			] = await Promise.all([
				listEventTypes(),
				listRuleHistory(),
				listCounters(),
				listAnchors(),
				listEvents(),
				getRoles(),
				listOpenPrompts(),
				listTimers(),
				listAgreements(),
				listRewardItems(),
			]);
			setTypes(typeRes.types);
			setRules(ruleRes.rules);
			setCounters(counterRes.counters);
			setAnchors(anchorRes.anchors);
			setEvents(eventRes.events);
			setMembers(roleRes.members);
			setOpenPrompts(promptRes.prompts);
			setTimers(timerRes.timers);
			setAgreements(agreementRes.agreements);
			setRewards(rewardRes.rewards);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't load the log.");
		}
	}, []);

	useEffect(() => {
		setReady(true);
		if (hasIdentity()) loadAll();
	}, [loadAll]);

	// The composer reads the definitions in force *now* (a rule's ref match is
	// what makes a field a picker); the queue keeps the versioned history because
	// it replays each event under the version in force at its log-time.
	const liveRules = useMemo(() => rules.map(currentRule), [rules]);

	const self = members.find((m) => m.is_self);
	const selfRole = self?.role ?? null;

	if (!ready) return null;
	if (!hasIdentity()) {
		return (
			<div className={pageClass}>
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
		// covers the last events in the stream — on top of the tab bar's own
		// spacer, which already clears the bar itself. Neither is needed at `lg`,
		// where that button is in the header instead of over the stream.
		<div className={`${pageRowsClass} space-y-4 pb-20 lg:pb-6`}>
			{/* The compose control is one button that changes where it lives, not a
			    phone copy and a desktop copy: a thumb needs it floating at the bottom
			    of the screen, a pointer wants it beside the heading it belongs to, and
			    two of them would be two things to keep in step and two hits for every
			    "Log an event" query in the tests. So it sits in the header in the
			    document and is lifted out of flow only below `lg`. */}
			<div className="flex items-center justify-between gap-3">
				<h1 className="text-2xl font-bold lg:text-3xl">Log</h1>

				<Sheet open={composerOpen} onOpenChange={setComposerOpen}>
					<SheetTrigger asChild>
						<Button
							className={`fixed ${ABOVE_TAB_BAR} left-1/2 z-40 -translate-x-1/2 shadow-lg lg:static lg:left-auto lg:translate-x-0 lg:shadow-sm`}
						>
							Log an event
						</Button>
					</SheetTrigger>
					<SheetContent title="Log an event">
						<LogComposer
							types={types}
							members={members}
							openPrompts={openPrompts}
							rules={liveRules}
							timers={timers}
							agreements={agreements}
							rewards={rewards}
							onLogged={() => {
								refreshLog();
								setComposerOpen(false);
							}}
						/>
					</SheetContent>
				</Sheet>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			{/* Queue stays top-of-page: for the dom it is the actionable part (#91). */}
			{/* Timers and counters reach the queue for the two state predicates
			    (ADR 0011, ADR 0015): the confirm sheet must resolve `timer_active` and
			    `counter_value` the same way the DO will, or it under-reports a
			    ruling's effects. Both refresh with the log. */}
			<QueuePanel
				events={events}
				types={types}
				rules={rules}
				members={members}
				anchors={anchors}
				timers={timers}
				counters={counters}
				selfRole={selfRole}
				onAmended={refreshLog}
			/>

			{/* Counters collapse behind a summary row so the surface reads as a log,
			    not a dashboard — the stream below gets the page (#91). */}
			<CountersSummary
				counters={counters}
				agreements={agreements}
				rewards={rewards}
				selfRole={selfRole}
				onChange={refreshLog}
			/>

			<EventStream
				events={events}
				types={types}
				agreements={agreements}
				rewards={rewards}
				members={members}
				selfId={self?.member_id ?? null}
				selfRole={selfRole}
				onAmended={refreshLog}
			/>
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
	agreements,
	rewards,
	selfRole,
	onChange,
}: {
	counters: Counter[];
	/** Passed through for the rung editor's term picker (#193, ADR 0015). */
	agreements: VersionedAgreement[];
	/** Passed through so a price crossing on a chain names its item (#194). */
	rewards: VersionedRewardItem[];
	selfRole: Role | null;
	onChange: () => void;
}) {
	const [open, setOpen] = useState(false);
	const panelId = useId();

	// The two states are separate elements, so both carry `aria-expanded` — a
	// screen reader meets whichever one is on screen, and each has to say which
	// state it is in (#148). Only the expanded one names the region: the panel
	// isn't rendered while collapsed, so an `aria-controls` there would dangle.
	if (open) {
		return (
			<div className="space-y-2">
				<div className="flex justify-end">
					<Button
						variant="ghost"
						size="sm"
						aria-expanded={true}
						aria-controls={panelId}
						onClick={() => setOpen(false)}
					>
						Collapse counters
					</Button>
				</div>
				<div id={panelId}>
					<CountersPanel
						counters={counters}
						agreements={agreements}
						rewards={rewards}
						selfRole={selfRole}
						onChange={onChange}
					/>
				</div>
			</div>
		);
	}

	return (
		<button
			type="button"
			aria-expanded={false}
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
