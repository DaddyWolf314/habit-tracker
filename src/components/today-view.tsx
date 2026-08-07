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

/**
 * Everything on this screen that can change under the viewer, fetched in one
 * place (#200). The first load and the poll both go through here, so a panel
 * added to one can't be missing from the other — the drift #193 hit when it had
 * to add `listAgreements()` to two hand-written copies of this list, whose
 * failure mode (a panel that is empty until the first poll, or one that goes
 * stale after it) throws nothing.
 *
 * Fetches without setting: the first load needs the whole bundle in hand before
 * it commits any of it, so a failure leaves the screen on its error rather than
 * half-populated.
 */
async function fetchLive() {
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
	return {
		timers,
		prompts,
		counters,
		rules,
		types,
		awaiting,
		anchors,
		flags,
		events,
		agreements,
		rewards,
	};
}

type LiveBundle = Awaited<ReturnType<typeof fetchLive>>;

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

	// The other half of the one list: where the bundle lands. Adding a panel means
	// one line in `fetchLive` and one here, and getting only one of them wrong is
	// loud — the panel is empty always, not empty until the first poll.
	const applyLive = useCallback((live: LiveBundle) => {
		setTimers(live.timers);
		setEvents(live.events);
		setOpenPrompts(live.prompts);
		setCounters(live.counters);
		// Rules and types ride the poll too, not just the first load: a dom can
		// disable the rule behind a tick while the sub's Today is open, and a tick
		// armed off a rule that no longer fires is a button that looks like it
		// worked. `RuleChangeNotice` sits on this same screen precisely because a
		// partner's rule edits are live news here.
		setRules(live.rules);
		setTypes(live.types);
		setAwaiting(live.awaiting);
		setAnchors(live.anchors);
		setFlags(live.flags);
		// The corpus rides the poll for the reason the rules do: a partner can
		// revise the term a standing rung cites while this screen is open, and the
		// banner has to be reading what binds now.
		setAgreements(live.agreements);
		// And the store, for the same reason again: a reprice while this screen is
		// open changes what "within reach" is true of (#194, ADR 0017).
		setRewards(live.rewards);
	}, []);

	const refresh = useCallback(async () => {
		applyLive(await fetchLive());
	}, [applyLive]);

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

	// The first load: the live bundle, plus the one fetch only it wants. Who is in
	// the couple doesn't change under the viewer — a membership change is a
	// re-onboard, not a poll tick — so `getRoles` is declared first-load-only here
	// rather than by being absent from a second copy of the list above.
	const loadAll = useCallback(async () => {
		try {
			const [live, { members }] = await Promise.all([fetchLive(), getRoles()]);
			applyLive(live);
			setMembers(members);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't load your timers.",
			);
		}
	}, [applyLive]);

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
			<h1 className="text-2xl font-bold">Today</h1>

			{error && <p className="text-sm text-destructive">{error}</p>}

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

			{/* Above the targets: a standing rung is a term the couple agreed, and it
			    outranks what you are aiming at today. */}
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
	);
}
