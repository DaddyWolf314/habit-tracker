import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { fieldClass } from "#/components/ui/field.ts";
import { Input } from "#/components/ui/input.tsx";
import { logEvent } from "#/lib/api.ts";
import {
	type EventType,
	type MetadataField,
	optionLabel,
} from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { MetadataValue } from "#/shared/roles.ts";
import { formatElapsed, type TimerView } from "#/shared/timers.ts";
import { humanize } from "#/shared/trace.ts";

/** The pack ids this panel reads its vocabulary and its contents from. */
const SESSION_STARTED = "session_started";
const SESSION_ENDED = "session_ended";
const ACT_TYPE = "act";

/**
 * The enum field a type declares under `key`, or undefined when the type is
 * absent or the field is some other kind. The single seam this panel reads its
 * vocabularies through (#182): the activity list used to be a hardcoded copy of
 * the pack's enum, which meant the pack's own `option_labels` were ignored and a
 * couple-added option could never appear.
 */
function enumField(
	types: EventType[],
	typeId: string,
	key: string,
): MetadataField | undefined {
	const field = types.find((t) => t.id === typeId)?.metadata[key];
	return field?.kind === "enum" ? field : undefined;
}

/** Options a field declares, or none when the type hasn't loaded yet. */
function optionsOf(field: MetadataField | undefined): string[] {
	return field?.kind === "enum" ? field.options : [];
}

/**
 * How one option reads. Routes through {@link optionLabel} so the pack's copy
 * wins (#155) and an unlabelled couple-added option de-slugs rather than
 * printing its token; falls back to the de-slug alone before the types arrive.
 */
function labelOption(field: MetadataField | undefined, option: string): string {
	return field ? optionLabel(field, option) : humanize(option);
}

/** The non-empty `session_id` a stopwatch pinned on open (from R15's `match_on`). */
function sessionIdOf(t: TimerView): MetadataValue | null {
	const id = t.match.session_id;
	return id !== undefined && id !== "" ? id : null;
}

/**
 * What happened inside one session: every event echoing its `session_id`, minus
 * the pair that bounds it and anything withdrawn. Reads the metadata rather than
 * a type allowlist, so `orgasm` and `edge` — which gained `session_id` in the
 * same change — appear beside an `act` without this panel naming them.
 */
function contentsOf(events: EventView[], sessionId: string): EventView[] {
	return events
		.filter(
			(e) =>
				e.composite_metadata.session_id === sessionId &&
				e.type !== SESSION_STARTED &&
				e.type !== SESSION_ENDED &&
				!e.retracted,
		)
		.sort((a, b) => a.occurred_at - b.occurred_at);
}

/**
 * Stopwatches panel (handoff §9 today view, §4.5; issue #90). Turns the paired
 * `session_started`/`session_ended` event model into a one-tap stopwatch: starting
 * needs no `session_id` at all (the server mints it, ADR 0005), running sessions
 * tick their elapsed time live, and Stop logs the matching `session_ended`
 * echoing the row's own `session_id` and `activity` — so a typo can never leave a
 * session open. This is pure UI over the event model (rules R15/R16 open and
 * close the stopwatch); the over-max auto-close (§4.5) surfaces here as a closed
 * row, not new model surface.
 */
export function StopwatchesPanel({
	timers,
	types,
	events,
	members,
	selfId,
	onChange,
}: {
	timers: TimerView[];
	types: EventType[];
	events: EventView[];
	members: RoleMember[];
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

	// Both vocabularies come off the pack types rather than a local copy (#182).
	const activityField = enumField(types, SESSION_STARTED, "activity");
	const actField = enumField(types, ACT_TYPE, "act");
	// Who a session is about, by its minted id — the default recipient for an act
	// logged inside it. Read off the opening event because the timer row carries
	// only `session_id` and `activity`, never a subject.
	const sessionSubjects = useMemo(() => {
		const bySession = new Map<string, string>();
		for (const e of events) {
			if (e.type !== SESSION_STARTED || !e.subject) continue;
			const id = e.composite_metadata.session_id;
			if (typeof id === "string" && id !== "") bySession.set(id, e.subject);
		}
		return bySession;
	}, [events]);

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
				<StartForm
					subjectId={selfId}
					field={activityField}
					onStarted={onChange}
				/>
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
					{active.map((t) => {
						const sessionId = sessionIdOf(t);
						const id = sessionId === null ? null : String(sessionId);
						const contents = id === null ? [] : contentsOf(events, id);
						return (
							<li key={t.id} className="rounded-md border px-3 py-2">
								<div className="flex items-center gap-3">
									<div className="min-w-0 flex-1 font-medium">
										{labelOption(activityField, t.tag ?? "session")}
									</div>
									<span className="w-20 text-right text-sm font-semibold tabular-nums">
										{formatElapsed(now - (t.opened_at ?? now))}
									</span>
									{/* Only render Stop when it can actually close this row —
									    otherwise the click would silently no-op. R15 always pins
									    both, so in practice it always shows. */}
									{selfId && sessionId !== null && t.tag !== null && (
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

								{contents.length > 0 && (
									<ul className="mt-2 space-y-0.5 border-l pl-3">
										{contents.map((e) => (
											<li
												key={e.id}
												className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground"
											>
												<span className="truncate">
													{describeContent(e, types, actField)}
												</span>
												<span className="shrink-0 tabular-nums">
													{formatClock(e.occurred_at)}
												</span>
											</li>
										))}
									</ul>
								)}

								{selfId && id !== null && (
									<ActForm
										sessionId={id}
										field={actField}
										members={members}
										defaultSubject={sessionSubjects.get(id) ?? selfId}
										onLogged={onChange}
									/>
								)}
							</li>
						);
					})}
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
									{labelOption(activityField, t.tag ?? "session")}
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
 * The start-a-session control (#90): pick an activity and start. The event
 * carries only the activity — `session_id` is an originating ref the server mints
 * at log time (ADR 0005) and rejects if supplied, so there is no client id to
 * make; rule R15 opens the stopwatch keyed by whatever was minted. The event is
 * about the member running the session, so `subject` is their own id.
 */
function StartForm({
	subjectId,
	field,
	onStarted,
}: {
	subjectId: string;
	field: MetadataField | undefined;
	onStarted: () => void;
}) {
	const activityId = useId();
	const options = optionsOf(field);
	const [activity, setActivity] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Preselect the pack's first activity once the types land, but never override
	// a choice already made — the list arrives a tick after the first render.
	const fallback = options[0] ?? "";
	const chosen = activity === "" ? fallback : activity;

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			await logEvent({
				type: "session_started",
				subject: subjectId,
				metadata: { activity: chosen },
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
				<label htmlFor={activityId} className="text-xs text-muted-foreground">
					Activity
				</label>
				<select
					id={activityId}
					className={`${fieldClass} mt-1`}
					value={chosen}
					onChange={(e) => setActivity(e.target.value)}
				>
					{options.map((a) => (
						<option key={a} value={a}>
							{labelOption(field, a)}
						</option>
					))}
				</select>
			</div>
			<Button onClick={submit} disabled={busy || chosen === ""}>
				{busy ? "…" : "Start session"}
			</Button>
			{error && <p className="w-full text-sm text-destructive">{error}</p>}
		</div>
	);
}

/**
 * Logging one act against a running session (#182). The whole point of putting
 * this on the session card is that `session_id` is supplied from the row — an
 * act echoes a ref it does not close, so the composer's picker is the
 * after-the-fact path and this one cannot mistype at all.
 *
 * `subject` is the act's **recipient**, defaulting to whoever the session is
 * about. Overridable rather than pinned: a session about the sub can still
 * contain an act the dom received, and pinning it would quietly record the
 * wrong person. Collapsed until asked for, so a card with several running
 * sessions stays scannable on a phone.
 */
function ActForm({
	sessionId,
	field,
	members,
	defaultSubject,
	onLogged,
}: {
	sessionId: string;
	field: MetadataField | undefined;
	members: RoleMember[];
	defaultSubject: string;
	onLogged: () => void;
}) {
	const actId = useId();
	const detailId = useId();
	const subjectFieldId = useId();
	const [open, setOpen] = useState(false);
	// No preselected act: these are not interchangeable, and a mis-tap on a
	// preselected option would record something that did not happen. The same
	// reasoning #94 applied to visibility — an unmade choice must not resolve
	// itself — for the one field that says what was done.
	const [act, setAct] = useState("");
	const [detail, setDetail] = useState("");
	const [subject, setSubject] = useState(defaultSubject);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const options = optionsOf(field);

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			await logEvent({
				type: ACT_TYPE,
				subject,
				metadata: {
					act,
					session_id: sessionId,
					...(detail.trim() ? { detail: detail.trim() } : {}),
				},
			});
			setAct("");
			setDetail("");
			setOpen(false);
			onLogged();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't log that act.");
		} finally {
			setBusy(false);
		}
	}

	// Nothing to pick — the types have not arrived yet. An empty select is worse
	// than no control at all.
	if (options.length === 0) return null;

	if (!open) {
		return (
			<Button variant="ghost" className="mt-2" onClick={() => setOpen(true)}>
				+ Log an act
			</Button>
		);
	}

	return (
		<div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2">
			<div>
				<label htmlFor={actId} className="text-xs text-muted-foreground">
					Act
				</label>
				<select
					id={actId}
					className={`${fieldClass} mt-1`}
					value={act}
					onChange={(e) => setAct(e.target.value)}
				>
					<option value="">Choose…</option>
					{options.map((o) => (
						<option key={o} value={o}>
							{labelOption(field, o)}
						</option>
					))}
				</select>
			</div>

			<div>
				<label
					htmlFor={subjectFieldId}
					className="text-xs text-muted-foreground"
				>
					About
				</label>
				<select
					id={subjectFieldId}
					className={`${fieldClass} mt-1`}
					value={subject}
					onChange={(e) => setSubject(e.target.value)}
				>
					{members.map((m) => (
						<option key={m.member_id} value={m.member_id}>
							{m.is_self ? `you (${m.role ?? "?"})` : (m.role ?? "partner")}
						</option>
					))}
				</select>
			</div>

			<div>
				<label htmlFor={detailId} className="text-xs text-muted-foreground">
					Detail (optional)
				</label>
				<Input
					id={detailId}
					className="mt-1"
					maxLength={80}
					value={detail}
					onChange={(e) => setDetail(e.target.value)}
				/>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<div className="flex gap-2">
				<Button onClick={submit} disabled={busy || act === ""}>
					{busy ? "…" : "Log act"}
				</Button>
				<Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

/**
 * One line in a session's contents. An act reads as the act itself rather than
 * "Act · Impact" — the type name carries no information once you are looking at
 * a list of them — while an `orgasm` or `edge` reads as its type label.
 */
function describeContent(
	event: EventView,
	types: EventType[],
	actField: MetadataField | undefined,
): string {
	const label =
		types.find((t) => t.id === event.type)?.label ?? humanize(event.type);
	if (event.type !== ACT_TYPE) return label;
	const act = event.composite_metadata.act;
	if (typeof act !== "string") return label;
	const detail = event.composite_metadata.detail;
	const named = labelOption(actField, act);
	return typeof detail === "string" && detail !== ""
		? `${named} · ${detail}`
		: named;
}

/**
 * Clock time only. Everything in a running session happened today, so the log's
 * `formatTime` (which carries a month and day) would repeat the same date on
 * every line.
 */
function formatClock(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}
