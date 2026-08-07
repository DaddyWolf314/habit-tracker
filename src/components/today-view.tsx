import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { RuleChangeNotice } from "#/components/rule-change-notice.tsx";
import { AnchorsPanel } from "#/components/today/anchors-panel.tsx";
import { ConversationFlagsPanel } from "#/components/today/conversation-flags-panel.tsx";
import { CountdownsPanel } from "#/components/today/countdowns-panel.tsx";
import { JournalPromptsPanel } from "#/components/today/journal-prompts-panel.tsx";
import { QueueEntry } from "#/components/today/queue-entry.tsx";
import { RungsPanel } from "#/components/today/rungs-panel.tsx";
import { StopwatchesPanel } from "#/components/today/stopwatches-panel.tsx";
import { StorePanel } from "#/components/today/store-panel.tsx";
import { TargetsPanel } from "#/components/today/targets-panel.tsx";
import {
	columnsClass,
	pageClass,
	pageColumnsClass,
} from "#/components/ui/page.ts";
import {
	getRoles,
	listAgreements,
	listAnchors,
	listConversationFlags,
	listCounters,
	listEvents,
	listEventTypes,
	listOpenPrompts,
	listRewardItems,
	listRules,
	listTimers,
	queueCount,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import { LIVE_REFRESH_MS, useLiveRefresh } from "#/lib/use-live-refresh.ts";
import type { VersionedAgreement } from "#/shared/agreements.ts";
import type { AnchorView } from "#/shared/anchors.ts";
import type { ConversationFlagView } from "#/shared/conversations.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { OpenPromptView } from "#/shared/journaling.ts";
import type { VersionedRewardItem } from "#/shared/rewards.ts";
import type { Rule } from "#/shared/rules.ts";
import type { TimerView } from "#/shared/timers.ts";

/**
 * The Today surface (handoff §9 — "active countdowns … this one screen is the
 * MVP"). Owns the timer list and refreshes it after every mutation, plus a
 * low-frequency poll so a countdown the alarm expires server-side stops reading
 * as running without a page reload. Live *ticking* is a pure display concern and
 * lives in {@link CountdownsPanel}; there is no WebSocket push yet (the
 * architecture plans one, handoff §3.2).
 */

export function TodayView() {
	const [ready, setReady] = useState(false);
	const [timers, setTimers] = useState<TimerView[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [openPrompts, setOpenPrompts] = useState<OpenPromptView[]>([]);
	const [counters, setCounters] = useState<Counter[]>([]);
	// The corpus, for the rung banner (#193): a rung carries a number and cites an
	// Agreement for what crossing it means, so the words come from here.
	const [agreements, setAgreements] = useState<VersionedAgreement[]>([]);
	const [rewards, setRewards] = useState<VersionedRewardItem[]>([]);
	const [anchors, setAnchors] = useState<AnchorView[]>([]);
	// Folded server-side too (#88): a conversation flag is one metadata key, and
	// deriving it here would mean holding the whole log to find it.
	const [flags, setFlags] = useState<ConversationFlagView[]>([]);
	// What says which target rows are tickable (#135), so it has to stay current:
	// see the poll below.
	const [rules, setRules] = useState<Rule[]>([]);
	const [types, setTypes] = useState<EventType[]>([]);
	// The log, for the session card's contents list (#182): a running session
	// shows the acts logged against it, which is a read over events rather than
	// over timers. Bounded — `listEvents` caps at 200 server-side.
	const [events, setEvents] = useState<EventView[]>([]);
	// One integer, folded server-side: Today never holds the log (#136).
	const [awaiting, setAwaiting] = useState(0);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const [
			{ timers },
			{ prompts },
			{ counters },
			{ rules },
			{ types },
			{ awaiting },
			{ anchors },
			{ flags },
			{ events },
			{ agreements },
			{ rewards },
		] = await Promise.all([
			listTimers(),
			listOpenPrompts(),
			listCounters(),
			listRules(),
			listEventTypes(),
			queueCount(),
			listAnchors(),
			listConversationFlags(),
			listEvents(),
			listAgreements(),
			listRewardItems(),
		]);
		setTimers(timers);
		setEvents(events);
		setOpenPrompts(prompts);
		setCounters(counters);
		// Rules and types ride the poll too, not just the first load: a dom can
		// disable the rule behind a tick while the sub's Today is open, and a tick
		// armed off a rule that no longer fires is a button that looks like it
		// worked. `RuleChangeNotice` sits on this same screen precisely because a
		// partner's rule edits are live news here.
		setRules(rules);
		setTypes(types);
		setAwaiting(awaiting);
		setAnchors(anchors);
		setFlags(flags);
		// The corpus rides the poll for the reason the rules do: a partner can
		// revise the term a standing rung cites while this screen is open, and the
		// banner has to be reading what binds now.
		setAgreements(agreements);
		// And the store, for the same reason again: a reprice while this screen is
		// open changes what "within reach" is true of (#194, ADR 0017).
		setRewards(rewards);
	}, []);

	// The post-mutation callback children fire un-awaited: unlike the quiet
	// poll, a refetch failure right after a mutation must surface — the screen
	// would otherwise keep showing the pre-mutation timers with no explanation.
	const refreshAfterMutation = useCallback(async () => {
		try {
			await refresh();
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't refresh your timers.",
			);
		}
	}, [refresh]);

	const loadAll = useCallback(async () => {
		try {
			const [
				timerRes,
				roleRes,
				promptRes,
				counterRes,
				ruleRes,
				typeRes,
				eventRes,
				anchorRes,
				flagRes,
				logRes,
				agreementRes,
				rewardRes,
			] = await Promise.all([
				listTimers(),
				getRoles(),
				listOpenPrompts(),
				listCounters(),
				listRules(),
				listEventTypes(),
				queueCount(),
				listAnchors(),
				listConversationFlags(),
				listEvents(),
				listAgreements(),
				listRewardItems(),
			]);
			setTimers(timerRes.timers);
			setMembers(roleRes.members);
			setOpenPrompts(promptRes.prompts);
			setCounters(counterRes.counters);
			setRules(ruleRes.rules);
			setTypes(typeRes.types);
			setAwaiting(eventRes.awaiting);
			setAnchors(anchorRes.anchors);
			setFlags(flagRes.flags);
			setEvents(logRes.events);
			setAgreements(agreementRes.agreements);
			setRewards(rewardRes.rewards);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't load your timers.",
			);
		}
	}, []);

	useEffect(() => {
		setReady(true);
		if (hasIdentity()) loadAll();
	}, [loadAll]);

	// The alarm sweep flips a passed-deadline countdown to `expired` server-side;
	// with no live push a periodic re-list (plus a re-list on foreground) surfaces
	// that so the screen never shows a stale running countdown. Errors are
	// swallowed — loadAll already surfaced any first-load failure.
	useLiveRefresh(refresh, {
		intervalMs: LIVE_REFRESH_MS,
		enabled: ready && hasIdentity(),
	});

	const self = members.find((m) => m.is_self);
	const selfRole = self?.role ?? null;
	const partner = members.find((m) => !m.is_self);

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
		<div className={pageColumnsClass}>
			<h1 className="mb-4 text-2xl font-bold lg:text-3xl">Today</h1>

			{error && <p className="mb-4 text-sm text-destructive">{error}</p>}

			{/* Ten panels stacked in one column is a phone screen's answer, and it was
			    the only answer the app had: on a laptop it was the same column with
			    the countdowns pushed below the fold and half the width unused. The
			    panels are independent and ordered, which is exactly what a
			    multi-column flow takes — the order below is unchanged, and so is the
			    phone layout, which is still one column because that is all `columns-2`
			    turns on at `lg`. */}
			<div className={columnsClass}>
				<RuleChangeNotice />

				<QueueEntry count={awaiting} />

				{/* Above the glance panels: someone asking to talk outranks a day count,
				    and unlike everything below it, this one waits on a person. */}
				<ConversationFlagsPanel
					flags={flags}
					selfId={self?.member_id ?? null}
					onChange={refreshAfterMutation}
				/>

				<AnchorsPanel anchors={anchors} />

				{/* Above the targets: a standing rung is a term the couple agreed, and
				    it outranks what you are aiming at today. */}
				<RungsPanel counters={counters} agreements={agreements} />

				{/* The store's state half, beside the ladder's (#194, ADR 0017): the two
				    are the same kind of line passed, so they read together. */}
				<StorePanel items={rewards} counters={counters} />

				<TargetsPanel
					counters={counters}
					rules={rules}
					types={types}
					onChange={refreshAfterMutation}
				/>

				<StopwatchesPanel
					timers={timers}
					types={types}
					events={events}
					members={members}
					selfId={self?.member_id ?? null}
					onChange={refreshAfterMutation}
				/>

				<CountdownsPanel
					timers={timers}
					selfRole={selfRole}
					selfId={self?.member_id ?? null}
					partnerId={partner?.member_id ?? null}
					onChange={refreshAfterMutation}
				/>

				<JournalPromptsPanel
					openPrompts={openPrompts}
					onChange={refreshAfterMutation}
				/>
			</div>
		</div>
	);
}
