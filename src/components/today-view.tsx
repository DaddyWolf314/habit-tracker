import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { RuleChangeNotice } from "#/components/rule-change-notice.tsx";
import { CountdownsPanel } from "#/components/today/countdowns-panel.tsx";
import { JournalPromptsPanel } from "#/components/today/journal-prompts-panel.tsx";
import { StopwatchesPanel } from "#/components/today/stopwatches-panel.tsx";
import { TargetsPanel } from "#/components/today/targets-panel.tsx";
import {
	getRoles,
	listCounters,
	listEventTypes,
	listOpenPrompts,
	listRules,
	listTimers,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import { LIVE_REFRESH_MS, useLiveRefresh } from "#/lib/use-live-refresh.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { OpenPromptView } from "#/shared/journaling.ts";
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
	// Rules and types change under the viewer far less than counters do, but they
	// are what say which rows are tickable, so they ride the same load.
	const [rules, setRules] = useState<Rule[]>([]);
	const [types, setTypes] = useState<EventType[]>([]);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const [{ timers }, { prompts }, { counters }] = await Promise.all([
			listTimers(),
			listOpenPrompts(),
			listCounters(),
		]);
		setTimers(timers);
		setOpenPrompts(prompts);
		setCounters(counters);
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
			const [timerRes, roleRes, promptRes, counterRes, ruleRes, typeRes] =
				await Promise.all([
					listTimers(),
					getRoles(),
					listOpenPrompts(),
					listCounters(),
					listRules(),
					listEventTypes(),
				]);
			setTimers(timerRes.timers);
			setMembers(roleRes.members);
			setOpenPrompts(promptRes.prompts);
			setCounters(counterRes.counters);
			setRules(ruleRes.rules);
			setTypes(typeRes.types);
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

			<TargetsPanel
				counters={counters}
				rules={rules}
				types={types}
				onChange={refreshAfterMutation}
			/>

			<StopwatchesPanel
				timers={timers}
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
