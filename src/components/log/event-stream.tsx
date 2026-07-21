import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { amendEvent, getEventTrace } from "#/lib/api.ts";
import {
	type AmendmentLine,
	describeAmendment,
	isOwnPending,
} from "#/shared/adjudication.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { TraceRow } from "#/shared/trace.ts";
import {
	describeTraceRow,
	formatMetaValue,
	formatTime,
	memberLabel,
} from "./formatting.ts";

/** Glyphs for the amendment tones in the chain view (ruling/note/retraction/response). */
const TONE_MARK: Record<string, string> = {
	ruling: "⚖",
	note: "✎",
	retraction: "✕",
	response: "♥",
};

/**
 * The event stream (handoff §4.6, §9 surface 3): the append-only log in reverse
 * chronological order. Each entry renders its composite state (original overlaid
 * by amendments), a pending chip while an `awaiting` key is unset (or a withdrawn
 * chip once retracted), both timestamps, and a tap-to-open chain drill-in: the
 * original log → its amendments in order → the rules those fired and the
 * near-misses still waiting → the projections touched. The consent-record view
 * and the debugging view are the same screen.
 */
export function EventStream({
	events,
	types,
	members,
	selfId = null,
	onAmended,
}: {
	events: EventView[];
	types: EventType[];
	members: RoleMember[];
	/** The viewer's member id, so they can note/retract their own pending events. */
	selfId?: string | null;
	onAmended?: () => void;
}) {
	const typeMap = new Map(types.map((t) => [t.id, t]));

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Log</h2>
			<ul className="mt-3 divide-y">
				{events.length === 0 && (
					<li className="py-3 text-sm text-muted-foreground">
						Nothing logged yet.
					</li>
				)}
				{events.map((event) => (
					<EventRow
						key={event.id}
						event={event}
						label={typeMap.get(event.type)?.label ?? event.type}
						members={members}
						selfId={selfId}
						onAmended={onAmended}
					/>
				))}
			</ul>
		</section>
	);
}

function EventRow({
	event,
	label,
	members,
	selfId,
	onAmended,
}: {
	event: EventView;
	label: string;
	members: RoleMember[];
	selfId: string | null;
	onAmended?: () => void;
}) {
	const [trace, setTrace] = useState<TraceRow[] | null>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function toggle() {
		if (open) {
			setOpen(false);
			return;
		}
		setOpen(true);
		if (trace !== null) return;
		try {
			setError(null);
			setTrace((await getEventTrace(event.id)).rows);
		} catch (err) {
			// Leave trace null so tapping again retries rather than sticking.
			setError(err instanceof Error ? err.message : "Couldn't load the chain.");
		}
	}

	const meta = Object.entries(event.composite_metadata);
	// The in-force ruling on the viewer's own event, if any (amendments arrive in
	// created_at order, so the last adjudication is the current one). Drives the
	// sub-side reveal below.
	const ownRuling =
		selfId !== null && event.actor === selfId && !event.retracted
			? event.amendments.filter((a) => a.kind === "adjudication").at(-1)
			: undefined;

	return (
		<li className="py-3">
			<button
				type="button"
				className="flex w-full items-start justify-between gap-3 text-left"
				onClick={toggle}
			>
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-sm font-medium">
						<span className={event.retracted ? "line-through opacity-60" : ""}>
							{label}
						</span>
						{event.pending && (
							<span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
								awaiting ruling
							</span>
						)}
						{event.retracted && (
							<span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
								withdrawn
							</span>
						)}
					</div>
					<div className="text-xs text-muted-foreground">
						{memberLabel(event.actor, members)}
						{event.subject && (
							<> · about {memberLabel(event.subject, members)}</>
						)}
					</div>
					{meta.length > 0 && (
						<div className="mt-1 flex flex-wrap gap-1">
							{meta.map(([key, value]) => (
								<span
									key={key}
									className="rounded bg-muted px-1.5 py-0.5 text-xs"
								>
									{key}: {formatMetaValue(value)}
								</span>
							))}
						</div>
					)}
					{event.note && (
						<p className="mt-1 text-xs italic text-muted-foreground">
							“{event.note}”
						</p>
					)}
				</div>
				<div className="shrink-0 text-right text-xs text-muted-foreground">
					<div>{formatTime(event.occurred_at)}</div>
					{event.occurred_at !== event.logged_at && (
						<div>logged {formatTime(event.logged_at)}</div>
					)}
				</div>
			</button>

			{isOwnPending(event, selfId) && (
				<OwnEventActions eventId={event.id} onAmended={onAmended} />
			)}

			{ownRuling && <RulingReveal line={describeAmendment(ownRuling)} />}

			{open && (
				<div className="mt-2 space-y-3 rounded-md border bg-muted/40 p-3">
					<div>
						<p className="text-xs font-medium text-muted-foreground">Chain</p>
						<ol className="mt-1 space-y-1 text-xs text-muted-foreground">
							<li>
								• Logged by {memberLabel(event.actor, members)} ·{" "}
								{formatTime(event.logged_at)}
							</li>
							{event.amendments.map((amendment) => {
								const line = describeAmendment(amendment);
								return (
									<li key={amendment.id}>
										{TONE_MARK[line.tone]} {memberLabel(line.actor, members)}{" "}
										{line.summary} · {formatTime(line.at)}
										{line.note && (
											<span className="italic"> — “{line.note}”</span>
										)}
									</li>
								);
							})}
						</ol>
					</div>

					<div>
						<p className="text-xs font-medium text-muted-foreground">
							Effects &amp; near-misses
						</p>
						<ol className="mt-1 space-y-1 text-xs text-muted-foreground">
							{error && (
								<li className="text-destructive">{error} Tap to retry.</li>
							)}
							{!error && trace === null && <li>Loading…</li>}
							{trace?.length === 0 && (
								<li>No effects — this event touched no projections.</li>
							)}
							{trace?.map((row) => {
								const line = describeTraceRow(row);
								const isNearMiss = line.tone === "near_miss";
								return (
									<li
										key={row.id}
										className={isNearMiss ? "italic opacity-70" : undefined}
									>
										{isNearMiss ? "○ " : "• "}
										{line.summary}
										{line.note ? ` — ${line.note}` : ""}
									</li>
								);
							})}
						</ol>
					</div>
				</div>
			)}
		</li>
	);
}

/**
 * Sub-side amendment controls for the author's own pending event (handoff §4.2):
 * append a note (context, no rule effects) or retract it (removes it from the
 * queue and marks it withdrawn — never a delete). Retraction is a two-tap inline
 * confirm; a browser dialog would block the whole surface.
 */
function OwnEventActions({
	eventId,
	onAmended,
}: {
	eventId: string;
	onAmended?: () => void;
}) {
	const [mode, setMode] = useState<"idle" | "note" | "confirm">("idle");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function run(fn: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		try {
			await fn();
			setMode("idle");
			setNote("");
			onAmended?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't do that.");
		} finally {
			setBusy(false);
		}
	}

	const addNote = () =>
		run(() =>
			amendEvent({
				kind: "note_appended",
				target_event_id: eventId,
				note: note.trim(),
			}),
		);
	const retract = () =>
		run(() => amendEvent({ kind: "retracted", target_event_id: eventId }));

	return (
		<div className="mt-2 space-y-2">
			{mode === "idle" && (
				<div className="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => setMode("note")}
						disabled={busy}
					>
						Add note
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setMode("confirm")}
						disabled={busy}
					>
						Retract
					</Button>
				</div>
			)}

			{mode === "note" && (
				<div className="space-y-2">
					<Textarea
						value={note}
						onChange={(e) => setNote(e.target.value)}
						placeholder="Add context to this pending event…"
					/>
					<div className="flex gap-2">
						<Button size="sm" onClick={addNote} disabled={busy || !note.trim()}>
							{busy ? "…" : "Save note"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setMode("idle")}
							disabled={busy}
						>
							Cancel
						</Button>
					</div>
				</div>
			)}

			{mode === "confirm" && (
				<div className="flex items-center gap-2 text-xs">
					<span className="text-muted-foreground">
						Retract this event? It stays visible as withdrawn.
					</span>
					<Button
						variant="destructive"
						size="sm"
						onClick={retract}
						disabled={busy}
					>
						{busy ? "…" : "Yes, retract"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setMode("idle")}
						disabled={busy}
					>
						Cancel
					</Button>
				</div>
			)}

			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

/**
 * The sub-side ruling reveal (handoff §8, "Sub side"): receiving a ruling is
 * emotionally load-bearing, so the dom's decision is not dumped inline — it sits
 * behind a content-safe "You have an update" until the sub chooses to open it, a
 * small deliberate interaction. Shown on the author's own resolved event.
 *
 * V1 reveals on tap and stays open for the session; persistent read-state (so an
 * already-seen ruling stops announcing itself) rides in with content-free
 * notifications in Phase 6.
 */
function RulingReveal({ line }: { line: AmendmentLine }) {
	const [revealed, setRevealed] = useState(false);

	if (!revealed) {
		return (
			<Button
				variant="outline"
				size="sm"
				className="mt-2"
				onClick={() => setRevealed(true)}
			>
				You have an update — reveal
			</Button>
		);
	}

	return (
		<div className="mt-2 rounded-md border bg-muted/40 p-3 text-sm">
			<p className="font-medium">{line.summary}</p>
			{line.note && (
				<p className="mt-1 italic text-muted-foreground">“{line.note}”</p>
			)}
		</div>
	);
}
