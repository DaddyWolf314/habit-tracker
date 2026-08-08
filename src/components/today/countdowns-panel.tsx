import { useEffect, useId, useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Define } from "#/components/ui/define.tsx";
import { fieldClass } from "#/components/ui/field.ts";
import { Input } from "#/components/ui/input.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import {
	cancelTimer,
	extendTimer,
	logEvent,
	pauseTimer,
	resumeTimer,
} from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";
import { FLOOR_KEY, type Floor } from "#/shared/journaling.ts";
import type { Role } from "#/shared/roles.ts";
import {
	countdownRemainingMs,
	DURATION_UNITS,
	type DurationUnit,
	durationToMs,
	extendChoicesFor,
	formatRemaining,
	isCountdownExpired,
	type TimerView,
	toCountdown,
} from "#/shared/timers.ts";
import { humanize } from "#/shared/trace.ts";

/** Human label for a countdown definition (task_countdown → "Task"). */
const TIMER_LABELS: Record<string, string> = {
	task_countdown: "Task",
	denial_period: "Denial",
	journal_countdown: "Journal prompt",
};
function timerLabel(name: string): string {
	return TIMER_LABELS[name] ?? humanize(name);
}

/**
 * How a closed countdown's terminal disposition reads (#149). Each word is a
 * deliberate choice rather than the stored value passing through, even where
 * the two coincide:
 *
 * `expired` says **overdue** — the one word for a passed deadline on every
 * surface (CONTEXT.md), and what the prompt picker already calls the very same
 * row (`ref-candidates.ts`); reading "expired" here and "overdue" there would
 * be two names for one thing. `auto_closed` says **auto-closed**, which is what
 * the sessions panel and the trace ledger have always called it. `canceled`
 * keeps the verb of the dom command that wrote it, so the row can't be read as
 * something resumable — there is no reopen, and a replacement is a fresh
 * assignment.
 *
 * Lowercase throughout: this row is the twin of the sessions panel's
 * auto-closed row, down to the class list, and the live badge above it reads
 * `paused`/`overdue` the same way.
 */
const DISPOSITION_LABELS: Record<string, string> = {
	expired: "overdue",
	canceled: "canceled",
	completed: "completed",
	failed: "failed",
	auto_closed: "auto-closed",
};

/**
 * The above, with a de-slugging fallback — `timerViewSchema.status` is an open
 * string rather than a closed enum, so a disposition added after this map
 * degrades to readable instead of dumping its stored value on the page.
 * `humanize` leaves the case alone, so the fallback lands in the same register
 * as the mapped words rather than announcing itself as the odd one out.
 */
function dispositionLabel(status: string): string {
	return DISPOSITION_LABELS[status] ?? humanize(status);
}

/** The non-empty `task_id` a task countdown carries, or null (denial has none). */
function taskIdOf(t: TimerView): string | null {
	const id = t.match.task_id;
	return typeof id === "string" && id !== "" ? id : null;
}

/**
 * What a task countdown is *called*, or null if the row can't say. The id is a
 * minted ULID now (ADR 0005), so the readable name rides the row's `tag`, routed
 * by R22 from the assigning event's `task_name` — exactly as a stopwatch's tag
 * carries its activity.
 *
 * Null has two causes, and neither may fall back to the id. A couple who once
 * edited R22 keeps their own definition through a pack bump (adopt-on-edit,
 * ADR 0002), so their rows are opened without a `tag`; and rows assigned before
 * the change carry a hand-typed name *as* the id. Printing the raw value would
 * show one couple a bare ULID; the row still reads as its timer label and
 * remaining time, which is what the countdown is for.
 */
function taskNameOf(t: TimerView): string | null {
	return t.tag !== null && t.tag !== "" ? t.tag : null;
}

/**
 * How each `quality` reads *in this form* (#154). Claim-shaped, because of who
 * is speaking: here the sub says how they think they did. "Exceeded" as a lone
 * word is a verdict, and a verdict on your own work is exactly what leaving the
 * field blank exists to avoid — `quality` is an `awaiting` key adjudicated by
 * the dom (ADR 0003), so a blank lands the completion pending their ruling.
 *
 * Local to this form on purpose, and now a *surface override* rather than the
 * gap it was: since #155 the pack carries `option_labels` on every enum, so the
 * queue, the composer and the log all read `quality` as words instead of the
 * stored token. What they read is the pack's **neutral** copy ("Beyond what was
 * asked"), which is the right register for the dom ruling on the work and the
 * wrong one for the sub describing their own — hence these. Keep the two in
 * step: a change to the pack's quality copy should be answered here or
 * deliberately not.
 *
 * The options are derived from these keys so the set is written once. `quality`
 * is a closed enum in the pack, so this matches exhaustively and needs no
 * fallback — a test pins these keys to the pack's `options` to keep that true.
 */
const QUALITY_LABELS = {
	exceeded: "Went beyond what was asked",
	met: "Did what was asked",
	partial: "Got part of the way",
} as const;

const QUALITY_OPTIONS = Object.keys(QUALITY_LABELS) as Array<
	keyof typeof QUALITY_LABELS
>;

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
	// The countdown awaiting a second tap to be called off. Cancelling writes the
	// terminal `canceled` disposition and there is no reopen — a replacement is a
	// fresh assignment that loses the elapsed time — and the control sits in the
	// same row as the reversible Pause and +extend, so it takes the house guard.
	const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

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
	// Narrowed on the way out of the partition, so the disposition copy below
	// takes the status it is guaranteed rather than a nullable it must re-check.
	const closed = countdowns.filter(
		(t): t is TimerView & { status: string } => t.status !== null,
	);

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Countdowns</h2>
			{/* The section that is *about* countdowns, so the word is defined here
			    rather than beside every row that is one (#212 item 4). */}
			<Define terms={["countdown"]} />

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
						const taskName = taskNameOf(t);
						// Extend options scaled to what's left (#95): a fixed +10m is
						// useless against a multi-day denial, so the choices track the
						// countdown's magnitude.
						const extendChoices = extendChoicesFor(
							countdownRemainingMs(c, now),
						);
						return (
							<li key={t.id} className="rounded-md border px-3 py-2">
								<div className="flex items-center gap-3">
									<div className="min-w-0 flex-1">
										<div className="font-medium">{timerLabel(t.timer)}</div>
										{taskName && (
											<div className="truncate text-xs text-muted-foreground">
												{taskName}
											</div>
										)}
									</div>
									<span className="w-20 text-right text-sm font-semibold tabular-nums">
										{/* "overdue", not "due": one word for a passed deadline on
										    every surface (CONTEXT.md) — the same one the closed row
										    below and the prompt picker use (#149). */}
										{paused
											? "paused"
											: overdue
												? "overdue"
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
											{extendChoices.map((choice) => (
												<Button
													key={choice.label}
													variant="outline"
													size="sm"
													disabled={busy === t.id}
													onClick={() =>
														run(t.id, () => extendTimer(t.id, choice.ms))
													}
												>
													{choice.label}
												</Button>
											))}
											{confirmCancel === t.id ? (
												<InlineConfirm
													label="Yes, cancel it"
													cancelLabel="Keep it running"
													busy={busy === t.id}
													onConfirm={() =>
														run(t.id, async () => {
															await cancelTimer(t.id);
															setConfirmCancel(null);
														})
													}
													onCancel={() => setConfirmCancel(null)}
												/>
											) : (
												<Button
													variant="ghost"
													size="sm"
													className="text-destructive"
													disabled={busy === t.id}
													onClick={() => setConfirmCancel(t.id)}
												>
													Cancel
												</Button>
											)}
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
						const taskName = taskNameOf(t);
						return (
							<li
								key={t.id}
								className="flex items-center justify-between text-xs text-muted-foreground"
							>
								<span className="truncate">
									{timerLabel(t.timer)}
									{taskName ? ` · ${taskName}` : ""}
								</span>
								<span className="tabular-nums">
									{dispositionLabel(t.status)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

/** The three things the dom can assign here; each maps to one logged event. */
type AssignKind = "task" | "denial" | "journal";

/**
 * The per-kind assign copy — the tab label, the note-field prompt, and the submit
 * verb. `journal` opens a `journal_countdown` on a policy-default deadline (R19),
 * so it carries no duration field; task and denial route `duration_ms`.
 */
const ASSIGN_KINDS: Record<
	AssignKind,
	{ tab: string; notePrompt: string; submit: string }
> = {
	task: {
		tab: "Assign task",
		notePrompt: "What is the task?",
		submit: "Assign",
	},
	denial: {
		tab: "Start denial",
		notePrompt: "Anything to say about this denial?",
		submit: "Start",
	},
	journal: {
		tab: "Assign prompt",
		notePrompt: "What should they reflect on?",
		submit: "Assign",
	},
};

/**
 * The dom's assign form. Logs a `task_assigned`, `denial_started`, or
 * `journal_prompt` event (ADR 0004, R19) via the ordinary event path — a rule
 * opens the countdown — so there is no timer-assign endpoint. The task's name is
 * ordinary display data (`task_name`, ADR 0005) — a catalog is a future concern
 * (issue #95). A task/denial deadline is entered as a value plus a unit and routed
 * as `duration_ms`; a journal prompt has no duration (its countdown uses a policy
 * default) and instead carries an optional visibility `floor` (issue #59). Neither
 * the `task_id` nor the `prompt_id` is sent from here: both are originating refs
 * the server mints, and it rejects a supplied value outright.
 */
function AssignForm({
	partnerId,
	onAssigned,
}: {
	partnerId: string | null;
	onAssigned: () => void;
}) {
	// Prefix for this form's field ids, so the labels below can name their
	// controls explicitly (#148).
	const ids = useId();
	const [kind, setKind] = useState<AssignKind>("task");
	const [taskName, setTaskName] = useState("");
	const [amount, setAmount] = useState("");
	const [unit, setUnit] = useState<DurationUnit>("minutes");
	const [floor, setFloor] = useState<Floor | "">("");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		if (!partnerId) {
			setError("No partner to assign to yet.");
			return;
		}
		// A journal prompt's countdown runs on a policy-default deadline (R19), so it
		// takes no duration — the question (in `note`) is what it needs.
		const durationValue = Number(amount);
		if (kind === "journal") {
			if (!note.trim()) {
				setError("Write the prompt they should reflect on.");
				return;
			}
		} else {
			if (!Number.isFinite(durationValue) || durationValue <= 0) {
				setError("Enter a positive duration.");
				return;
			}
			if (kind === "task" && !taskName.trim()) {
				setError("A task needs a name.");
				return;
			}
		}
		setBusy(true);
		setError(null);
		try {
			// Each kind is a dom-authored event about the sub (subject) — a rule opens
			// the countdown (ADR 0004), so this goes through logEvent, not a timer
			// command. The originating refs (`prompt_id`, `task_id`) are minted
			// server-side (ADR 0005), so neither is sent: a prompt carries only its
			// optional floor, a task only its name and deadline.
			let type: "task_assigned" | "denial_started" | "journal_prompt";
			const metadata: Record<string, string | number> = {};
			if (kind === "journal") {
				type = "journal_prompt";
				if (floor) metadata[FLOOR_KEY] = floor;
			} else {
				metadata.duration_ms = durationToMs(durationValue, unit);
				if (kind === "task") {
					type = "task_assigned";
					metadata.task_name = taskName.trim();
				} else {
					type = "denial_started";
				}
			}
			await logEvent({
				type,
				metadata,
				subject: partnerId,
				note: note.trim() || undefined,
			});
			setTaskName("");
			setAmount("");
			setFloor("");
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
			<div className="flex flex-wrap gap-2">
				{(Object.keys(ASSIGN_KINDS) as AssignKind[]).map((k) => (
					<Button
						key={k}
						variant={kind === k ? "default" : "ghost"}
						size="sm"
						onClick={() => setKind(k)}
					>
						{ASSIGN_KINDS[k].tab}
					</Button>
				))}
			</div>

			{kind === "task" && (
				<Input
					placeholder="Task (e.g. dishes)"
					value={taskName}
					onChange={(e) => setTaskName(e.target.value)}
				/>
			)}
			{kind !== "journal" && (
				<div className="flex gap-2">
					<Input
						className="flex-1"
						type="number"
						min={1}
						placeholder="Duration"
						value={amount}
						onChange={(e) => setAmount(e.target.value)}
					/>
					<label htmlFor={`${ids}-unit`} className="sr-only">
						Unit
					</label>
					<select
						id={`${ids}-unit`}
						// `cn` and not a template string: `fieldClass` carries `w-full`,
						// which plain concatenation lets win over `w-28` — the unit picker
						// then eats the row and collapses the flex-1 Duration input beside
						// it. Pre-dates #147; the other call sites append `mt-1` and don't
						// collide, so this is the only one that needs merging.
						className={cn(fieldClass, "w-28")}
						value={unit}
						onChange={(e) => setUnit(e.target.value as DurationUnit)}
					>
						{DURATION_UNITS.map((u) => (
							<option key={u.value} value={u.value}>
								{u.label}
							</option>
						))}
					</select>
				</div>
			)}
			{kind === "journal" && (
				<div>
					<label
						htmlFor={`${ids}-floor`}
						className="text-xs text-muted-foreground"
					>
						Minimum visibility to count
					</label>
					<select
						id={`${ids}-floor`}
						className={`${fieldClass} mt-1`}
						value={floor}
						onChange={(e) => setFloor(e.target.value as Floor | "")}
					>
						<option value="">Any answer (sealed or shared)</option>
						<option value="sealed">Sealed or higher</option>
						<option value="shared">Shared only</option>
					</select>
				</div>
			)}
			<Textarea
				placeholder={ASSIGN_KINDS[kind].notePrompt}
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<Button onClick={submit} disabled={busy}>
				{busy ? "…" : ASSIGN_KINDS[kind].submit}
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
 * completion pending the dom's ruling rather than self-assigning one. The event is
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
	// One of these per task row, so the id has to be per-instance (#148).
	const qualityId = useId();
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
				<label htmlFor={qualityId} className="text-xs text-muted-foreground">
					Quality (optional)
				</label>
				<select
					id={qualityId}
					className={`${fieldClass} mt-1`}
					value={quality}
					onChange={(e) => setQuality(e.target.value)}
				>
					<option value="">— (leave it for your dom to rule on)</option>
					{QUALITY_OPTIONS.map((q) => (
						<option key={q} value={q}>
							{QUALITY_LABELS[q]}
						</option>
					))}
				</select>
				{/* Both paths, not just the blank one (#154). Setting `quality` fills
				    the type's only `awaiting` key, so the completion is never pending
				    and never reaches the dom's ruling — a blank is what puts it there.
				    The option text taught the blank path and left the sub to discover
				    that picking one settles it. */}
				<p className="mt-1 text-xs text-muted-foreground">
					Whichever you pick stands as the record — your dom can change it
					later, but it won't be waiting on their ruling.
				</p>
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
