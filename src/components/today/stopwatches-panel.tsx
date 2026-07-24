import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { logEvent } from "#/lib/api.ts";
import { ulid } from "#/lib/ulid.ts";
import type { MetadataValue } from "#/shared/roles.ts";
import { formatElapsed, type TimerView } from "#/shared/timers.ts";

/** Shared field styling, matching the sibling panels (countdowns, journal-prompts). */
const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

/**
 * The activities a session can track (pack `event-types.json` — `session_started`'s
 * `activity` enum). Hardcoded here as the countdowns panel hardcodes its own enums;
 * a couple-editable activity set is a later concern.
 */
const ACTIVITY_OPTIONS = ["kneeling", "service", "wear", "scene"] as const;
type Activity = (typeof ACTIVITY_OPTIONS)[number];

/** Title-cases an activity for display (`kneeling` → `Kneeling`). */
function activityLabel(activity: string): string {
	return activity.charAt(0).toUpperCase() + activity.slice(1);
}

/** The non-empty `session_id` a stopwatch pinned on open (from R15's `match_on`). */
function sessionIdOf(t: TimerView): MetadataValue | null {
	const id = t.match.session_id;
	return id !== undefined && id !== "" ? id : null;
}

/**
 * Stopwatches panel (handoff §9 today view, §4.5; issue #90). Turns the paired
 * `session_started`/`session_ended` event model into a one-tap stopwatch: starting
 * mints the `session_id` so no one hand-pairs it, running sessions tick their
 * elapsed time live, and Stop logs the matching `session_ended` echoing the row's
 * own `session_id` and `activity` — so a typo can never leave a session open. This
 * is pure UI over the event model (rules R15/R16 open and close the stopwatch); the
 * over-max auto-close (§4.5) surfaces here as a closed row, not new model surface.
 */
export function StopwatchesPanel({
	timers,
	selfId,
	onChange,
}: {
	timers: TimerView[];
	selfId: string | null;
	onChange: () => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Tick once a second so a running stopwatch visibly counts up. Purely a display
	// re-render — the authoritative `opened_at` lives on the timer row.
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(id);
	}, []);

	async function run(id: string, fn: () => Promise<unknown>) {
		setBusy(id);
		setError(null);
		try {
			await fn();
			onChange();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(null);
		}
	}

	// A running stopwatch is one still open (no terminal status). `session_started`
	// requires a subject, so starting/stopping needs a self id to stamp as the
	// session's subject; without one the whole surface is read-only.
	const stopwatches = timers.filter((t) => t.kind === "stopwatch");
	const active = stopwatches.filter((t) => t.status === null);
	// Only auto-closed sessions linger below — a session left running past its
	// per-activity max (§4.5), which #90 asks Today to surface as the failure
	// handling. A normal Stop retires its session cleanly; completed sessions don't
	// accumulate here, so Today stays the "running stopwatches" screen (§9.2), not a
	// standing session log.
	const autoClosed = stopwatches.filter((t) => t.status === "auto_closed");

	async function stop(t: TimerView) {
		const sessionId = sessionIdOf(t);
		if (!selfId || sessionId === null || t.tag === null) return;
		// Echo the row's own `session_id` and `activity` (ADR 0004 pairing): R16
		// matches the open stopwatch on `session_id` and closes it, routing the
		// derived duration by `activity`. No hand-typed ref — the pair can't miss.
		// `subject` is self: this panel's Start only ever opens `subject=self`
		// sessions, so the close it pairs agrees with the open on subject too.
		await logEvent({
			type: "session_ended",
			subject: selfId,
			metadata: { session_id: sessionId, activity: t.tag },
		});
	}

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Sessions</h2>

			{selfId ? (
				<StartForm subjectId={selfId} onStarted={onChange} />
			) : (
				<p className="mt-2 text-sm text-muted-foreground">
					You need a confirmed role before you can start a session.
				</p>
			)}

			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}

			{active.length === 0 ? (
				<p className="mt-3 text-sm text-muted-foreground">
					No running sessions.
				</p>
			) : (
				<ul className="mt-3 space-y-2">
					{active.map((t) => (
						<li key={t.id} className="rounded-md border px-3 py-2">
							<div className="flex items-center gap-3">
								<div className="min-w-0 flex-1 font-medium">
									{activityLabel(t.tag ?? "session")}
								</div>
								<span className="w-20 text-right text-sm font-semibold tabular-nums">
									{formatElapsed(now - (t.opened_at ?? now))}
								</span>
								{/* Only render Stop when it can actually close this row —
								    otherwise the click would silently no-op. R15 always pins
								    both, so in practice it always shows. */}
								{selfId && sessionIdOf(t) !== null && t.tag !== null && (
									<Button
										variant="outline"
										size="sm"
										disabled={busy === t.id}
										onClick={() => run(t.id, () => stop(t))}
									>
										Stop
									</Button>
								)}
							</div>
						</li>
					))}
				</ul>
			)}

			{autoClosed.length > 0 && (
				<div className="mt-4 border-t pt-3">
					<p className="text-xs font-medium text-muted-foreground">
						Auto-closed past the limit
					</p>
					<ul className="mt-1 space-y-1">
						{autoClosed.map((t) => (
							<li
								key={t.id}
								className="flex items-center justify-between text-xs text-muted-foreground"
							>
								<span className="truncate">
									{activityLabel(t.tag ?? "session")}
									{t.duration_ms !== null
										? ` · ${formatElapsed(t.duration_ms)}`
										: ""}
								</span>
								<span className="tabular-nums">auto-closed</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

/**
 * The start-a-session control (#90): pick an activity and start. The `session_id`
 * is minted client-side with a {@link ulid} — a fresh id per session, monotonic so
 * two sessions started in the same instant never collide — and carried on the
 * `session_started` event; rule R15 opens the stopwatch keyed by it. The event is
 * about the member running the session, so `subject` is their own id.
 */
function StartForm({
	subjectId,
	onStarted,
}: {
	subjectId: string;
	onStarted: () => void;
}) {
	const [activity, setActivity] = useState<Activity>(ACTIVITY_OPTIONS[0]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			await logEvent({
				type: "session_started",
				subject: subjectId,
				metadata: { activity, session_id: ulid() },
			});
			onStarted();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't start that session.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 p-3">
			<div className="flex-1">
				{/** biome-ignore lint/a11y/noLabelWithoutControl: label wraps the select */}
				<label className="text-xs text-muted-foreground">Activity</label>
				<select
					className={`${fieldClass} mt-1`}
					value={activity}
					onChange={(e) => setActivity(e.target.value as Activity)}
				>
					{ACTIVITY_OPTIONS.map((a) => (
						<option key={a} value={a}>
							{activityLabel(a)}
						</option>
					))}
				</select>
			</div>
			<Button onClick={submit} disabled={busy}>
				{busy ? "…" : "Start session"}
			</Button>
			{error && <p className="w-full text-sm text-destructive">{error}</p>}
		</div>
	);
}
