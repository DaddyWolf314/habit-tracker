import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import {
	cancelTimer,
	extendTimer,
	logEvent,
	pauseTimer,
	resumeTimer,
} from "#/lib/api.ts";
import type { Role } from "#/shared/roles.ts";
import {
	type Countdown,
	countdownRemainingMs,
	formatRemaining,
	isCountdownExpired,
	type TimerView,
} from "#/shared/timers.ts";

const MINUTE_MS = 60_000;
/** One tap extends a countdown by this much (handoff §4.5 — dom extend). */
const EXTEND_MS = 10 * MINUTE_MS;

/** Shared field styling, matching the sibling panels (journal-prompts, log). */
const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

/** Human label for a countdown definition (task_countdown → "Task"). */
const TIMER_LABELS: Record<string, string> = {
	task_countdown: "Task",
	denial_period: "Denial",
	journal_countdown: "Journal prompt",
};
function timerLabel(name: string): string {
	return TIMER_LABELS[name] ?? name.replace(/_/g, " ");
}

/** The Countdown shape the pure timer helpers read, projected from a view. */
function toCountdown(t: TimerView): Countdown {
	return {
		opened_at: t.opened_at ?? 0,
		deadline_at: t.deadline_at ?? 0,
		paused_at: t.paused_at,
		remaining_ms: t.remaining_ms,
	};
}

/** The non-empty `task_id` a task countdown carries, or null (denial has none). */
function taskIdOf(t: TimerView): string | null {
	const id = t.match.task_id;
	return typeof id === "string" && id !== "" ? id : null;
}

/**
 * The `quality` grades a `task_completed` can carry (pack `event-types.json`).
 * The sub may leave it blank: `quality` is an `awaiting` key adjudicated by the
 * dom (ADR 0003), so an un-graded completion lands pending for the dom to rule on
 * — the mini-form never forces a grade.
 */
const QUALITY_OPTIONS = ["exceeded", "met", "partial"] as const;

/**
 * Whether a row is a task countdown the caller can close by completing it. Only
 * `task_countdown` carries a `task_id` to echo back on `task_completed`; a denial
 * has no sub action (issue #86) and a `journal_countdown` is answered from the
 * journal-prompts panel, not here.
 */
function isCompletableTask(t: TimerView): boolean {
	return t.timer === "task_countdown" && taskIdOf(t) !== null;
}

/**
 * Countdowns panel (handoff §9 today view; ADR 0004). Shows active countdowns
 * ticking live and, for the dom, the assign form and live controls. Assigning is
 * *not* a timer command — it logs a `task_assigned`/`denial_started` event that a
 * rule turns into a countdown; only pause/resume/extend/cancel are dom commands.
 */
export function CountdownsPanel({
	timers,
	selfRole,
	selfId,
	partnerId,
	onChange,
}: {
	timers: TimerView[];
	selfRole: Role | null;
	selfId: string | null;
	partnerId: string | null;
	onChange: () => void;
}) {
	// The whole dom surface — assign form and live controls — is gated on the dom
	// alone, even though `task_assigned`'s log_permission is [dom, switch]. The DO's
	// `assertDom` restricts the countdown commands (pause/resume/extend/cancel) to
	// the dom, so letting a switch assign here would strand them with a countdown
	// they can't then control. A switch who needs to assign uses the generic log
	// composer; the Today view stays coherent as a single dom-owned surface.
	const isDom = selfRole === "dom";
	// The sub under a task deadline closes it by logging the ordinary
	// `task_completed` (ADR 0004 — a rule matches the `task_id` and closes the
	// countdown). Issue #86 adds this affordance so the party with the longest
	// path no longer hand-copies the id into the Log composer. Gated to the
	// non-dom party (the countdown's subject); the dom keeps pause/extend/cancel.
	// A self id is required to stamp as the event subject (`subject_required`).
	const canMarkDone = selfId !== null && !isDom;
	const [now, setNow] = useState(() => Date.now());
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [markingDone, setMarkingDone] = useState<string | null>(null);

	// Tick once a second so a running countdown visibly counts down. Purely a
	// display re-render — the authoritative deadline lives on the timer row; a
	// pause/extend that changes it lands through onChange, not this interval.
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

	const countdowns = timers.filter((t) => t.kind === "countdown");
	const active = countdowns.filter((t) => t.status === null);
	const closed = countdowns.filter((t) => t.status !== null);

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Countdowns</h2>

			{isDom && <AssignForm partnerId={partnerId} onAssigned={onChange} />}

			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}

			{active.length === 0 ? (
				<p className="mt-3 text-sm text-muted-foreground">
					No active countdowns.
				</p>
			) : (
				<ul className="mt-3 space-y-2">
					{active.map((t) => {
						const c = toCountdown(t);
						const paused = t.paused_at != null;
						const overdue = isCountdownExpired(c, now);
						const taskId = taskIdOf(t);
						return (
							<li key={t.id} className="rounded-md border px-3 py-2">
								<div className="flex items-center gap-3">
									<div className="min-w-0 flex-1">
										<div className="font-medium">{timerLabel(t.timer)}</div>
										{taskId && (
											<div className="truncate text-xs text-muted-foreground">
												{taskId}
											</div>
										)}
									</div>
									<span className="w-20 text-right text-sm font-semibold tabular-nums">
										{paused
											? "paused"
											: overdue
												? "due"
												: formatRemaining(countdownRemainingMs(c, now))}
									</span>
									{isDom ? (
										<div className="flex gap-1">
											{paused ? (
												<Button
													variant="outline"
													size="sm"
													disabled={busy === t.id}
													onClick={() => run(t.id, () => resumeTimer(t.id))}
												>
													Resume
												</Button>
											) : (
												<Button
													variant="outline"
													size="sm"
													disabled={busy === t.id}
													onClick={() => run(t.id, () => pauseTimer(t.id))}
												>
													Pause
												</Button>
											)}
											<Button
												variant="outline"
												size="sm"
												disabled={busy === t.id}
												onClick={() =>
													run(t.id, () => extendTimer(t.id, EXTEND_MS))
												}
											>
												+10m
											</Button>
											<Button
												variant="ghost"
												size="sm"
												disabled={busy === t.id}
												onClick={() => run(t.id, () => cancelTimer(t.id))}
											>
												Cancel
											</Button>
										</div>
									) : (
										canMarkDone &&
										isCompletableTask(t) &&
										markingDone !== t.id && (
											<Button size="sm" onClick={() => setMarkingDone(t.id)}>
												Mark done
											</Button>
										)
									)}
								</div>
								{markingDone === t.id && taskId && selfId && (
									<MarkDoneForm
										taskId={taskId}
										subjectId={selfId}
										onCancel={() => setMarkingDone(null)}
										onDone={() => {
											setMarkingDone(null);
											onChange();
										}}
									/>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{closed.length > 0 && (
				<ul className="mt-4 space-y-1 border-t pt-3">
					{closed.map((t) => {
						const taskId = taskIdOf(t);
						return (
							<li
								key={t.id}
								className="flex items-center justify-between text-xs text-muted-foreground"
							>
								<span className="truncate">
									{timerLabel(t.timer)}
									{taskId ? ` · ${taskId}` : ""}
								</span>
								<span className="tabular-nums">{t.status}</span>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

/**
 * The dom's assign form. Logs a `task_assigned` or `denial_started` event (ADR
 * 0004) via the ordinary event path — a rule opens the countdown — so there is no
 * timer-assign endpoint. `task_id` is free text (a catalog is a future concern);
 * the deadline is entered in minutes and routed as `duration_ms`.
 */
function AssignForm({
	partnerId,
	onAssigned,
}: {
	partnerId: string | null;
	onAssigned: () => void;
}) {
	const [kind, setKind] = useState<"task" | "denial">("task");
	const [taskId, setTaskId] = useState("");
	const [minutes, setMinutes] = useState("");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		const mins = Number(minutes);
		if (!Number.isFinite(mins) || mins <= 0) {
			setError("Enter a positive number of minutes.");
			return;
		}
		if (kind === "task" && !taskId.trim()) {
			setError("A task needs an id.");
			return;
		}
		if (!partnerId) {
			setError("No partner to assign to yet.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const duration_ms = Math.round(mins * MINUTE_MS);
			// task_assigned adds the task ref; denial_started carries only the deadline.
			// Both are dom-authored events about the sub (subject) — a rule opens the
			// countdown (ADR 0004), so this goes through logEvent, not a timer command.
			await logEvent({
				type: kind === "task" ? "task_assigned" : "denial_started",
				subject: partnerId,
				metadata:
					kind === "task"
						? { task_id: taskId.trim(), duration_ms }
						: { duration_ms },
				note: note.trim() || undefined,
			});
			setTaskId("");
			setMinutes("");
			setNote("");
			onAssigned();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't assign that.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
			<div className="flex gap-2">
				<Button
					variant={kind === "task" ? "default" : "ghost"}
					size="sm"
					onClick={() => setKind("task")}
				>
					Assign task
				</Button>
				<Button
					variant={kind === "denial" ? "default" : "ghost"}
					size="sm"
					onClick={() => setKind("denial")}
				>
					Start denial
				</Button>
			</div>

			{kind === "task" && (
				<Input
					placeholder="Task id (e.g. dishes)"
					value={taskId}
					onChange={(e) => setTaskId(e.target.value)}
				/>
			)}
			<Input
				type="number"
				min={1}
				placeholder="Minutes"
				value={minutes}
				onChange={(e) => setMinutes(e.target.value)}
			/>
			<Textarea
				placeholder={
					kind === "task"
						? "What is the task?"
						: "Anything to say about this denial?"
				}
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<Button onClick={submit} disabled={busy}>
				{busy ? "…" : kind === "task" ? "Assign" : "Start"}
			</Button>
		</div>
	);
}

/**
 * The sub's inline "mark done" form for one task countdown (issue #86). It logs
 * an ordinary `task_completed` echoing the row's `task_id` — no hand-typed ref,
 * so a typo can never leave the countdown silently open — and rule R4 closes the
 * countdown on the `task_id` match (ADR 0004). `quality` is optional: it is an
 * `awaiting` key adjudicated by the dom (ADR 0003), so leaving it blank lands the
 * completion pending the dom's grade rather than self-assigning one. The event is
 * about the sub who did the task, so `subject` is their own member id.
 */
function MarkDoneForm({
	taskId,
	subjectId,
	onCancel,
	onDone,
}: {
	taskId: string;
	subjectId: string;
	onCancel: () => void;
	onDone: () => void;
}) {
	const [quality, setQuality] = useState("");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			await logEvent({
				type: "task_completed",
				subject: subjectId,
				metadata: quality ? { task_id: taskId, quality } : { task_id: taskId },
				note: note.trim() || undefined,
			});
			onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't mark that done.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-2 space-y-2">
			<div>
				{/** biome-ignore lint/a11y/noLabelWithoutControl: label wraps the select */}
				<label className="text-xs text-muted-foreground">
					Quality (optional)
				</label>
				<select
					className={`${fieldClass} mt-1`}
					value={quality}
					onChange={(e) => setQuality(e.target.value)}
				>
					<option value="">— (leave for your dom to grade)</option>
					{QUALITY_OPTIONS.map((q) => (
						<option key={q} value={q}>
							{q}
						</option>
					))}
				</select>
			</div>
			<Textarea
				placeholder="Anything you want to say about this?"
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<div className="flex gap-2">
				<Button onClick={submit} disabled={busy}>
					{busy ? "…" : "Mark done"}
				</Button>
				<Button variant="ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
