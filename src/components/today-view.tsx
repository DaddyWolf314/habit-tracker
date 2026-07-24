import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CountdownsPanel } from "#/components/today/countdowns-panel.tsx";
import { getRoles, listTimers } from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { TimerView } from "#/shared/timers.ts";

/**
 * The Today surface (handoff §9 — "active countdowns … this one screen is the
 * MVP"). Owns the timer list and refreshes it after every mutation, plus a
 * low-frequency poll so a countdown the alarm expires server-side stops reading
 * as running without a page reload. Live *ticking* is a pure display concern and
 * lives in {@link CountdownsPanel}; there is no WebSocket push (a non-goal here,
 * ADR 0004).
 */
const POLL_MS = 15_000;

export function TodayView() {
	const [ready, setReady] = useState(false);
	const [timers, setTimers] = useState<TimerView[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const { timers } = await listTimers();
		setTimers(timers);
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
			const [timerRes, roleRes] = await Promise.all([listTimers(), getRoles()]);
			setTimers(timerRes.timers);
			setMembers(roleRes.members);
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
	// with no live push a periodic re-list surfaces that so the screen never shows
	// a stale running countdown. A swallowed error keeps a transient blip quiet —
	// loadAll already surfaced the first-load failure.
	useEffect(() => {
		if (!hasIdentity()) return;
		const id = setInterval(() => {
			refresh().catch(() => {});
		}, POLL_MS);
		return () => clearInterval(id);
	}, [refresh]);

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
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">Today</h1>
				<Link to="/" className="text-sm underline">
					Back
				</Link>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<CountdownsPanel
				timers={timers}
				selfRole={selfRole}
				partnerId={partner?.member_id ?? null}
				onChange={refreshAfterMutation}
			/>
		</div>
	);
}
