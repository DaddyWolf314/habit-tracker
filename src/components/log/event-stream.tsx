import { useId, useMemo, useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { ResponseComposer } from "#/components/response-composer.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { ackUpdates, amendEvent, getEventTrace } from "#/lib/api.ts";
import {
	type AmendmentLine,
	canRespondTo,
	describeAmendment,
	isOwnPending,
} from "#/shared/adjudication.ts";
import {
	describeCitation,
	type VersionedAgreement,
} from "#/shared/agreements.ts";
import { canWaiveEffects } from "#/shared/amendment-validation.ts";
import type { WaivedEffect } from "#/shared/amendments.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { isCitingRef, readableMetadata } from "#/shared/refs.ts";
import { standingEffects, waivedEffectOf } from "#/shared/reversal.ts";
import {
	describeRewardCitation,
	REWARD_REF_KIND,
	type VersionedRewardItem,
} from "#/shared/rewards.ts";
import type { MetadataValue, Role } from "#/shared/roles.ts";
import type { TraceRow } from "#/shared/trace.ts";
import {
	describeTraceRow,
	displayMetaValue,
	formatMetaValue,
	formatTime,
	memberLabel,
} from "./formatting.ts";

/** Glyphs for the amendment tones in the chain view (ruling/note/retraction/response/waiver). */
const TONE_MARK: Record<string, string> = {
	ruling: "⚖",
	note: "✎",
	retraction: "✕",
	response: "♥",
	waiver: "⊘",
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
	agreements = [],
	rewards = [],
	selfId = null,
	selfRole = null,
	onAmended,
}: {
	events: EventView[];
	types: EventType[];
	members: RoleMember[];
	/** The corpus, so a citation reads as a name rather than an id (#121). */
	agreements?: VersionedAgreement[];
	/**
	 * The store, so a redemption's `reward_ref` reads as the item's name and a
	 * price crossing on its chain names what became affordable (#194, ADR 0017).
	 * The corpus's argument, applied to the other citing kind: a row saying
	 * "spent 40 on 01JB6X…" carries the number and loses the thing bought.
	 */
	rewards?: VersionedRewardItem[];
	/**
	 * The viewer's member id: it decides whose row this is, and so which of the
	 * three amendment affordances a row offers — note/retract on your own pending
	 * event, respond on your partner's (#183), reveal on your own once they have
	 * said something back.
	 */
	selfId?: string | null;
	/**
	 * The viewer's role, for the one affordance that is about authority rather
	 * than authorship: waiving a landed effect is gated on the roles that may
	 * author rules (ADR 0016), and a row's own author has nothing to do with it.
	 */
	selfRole?: Role | null;
	onAmended?: () => void;
}) {
	const typeMap = new Map(types.map((t) => [t.id, t]));
	// One read for the whole list: "(now: …)" only ever compares against the
	// current name, and nothing here is a clock.
	const now = Date.now();

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
						agreements={agreements}
						rewards={rewards}
						now={now}
						key={event.id}
						event={event}
						type={typeMap.get(event.type)}
						members={members}
						selfId={selfId}
						selfRole={selfRole}
						onAmended={onAmended}
					/>
				))}
			</ul>
		</section>
	);
}

function EventRow({
	agreements,
	rewards,
	now,
	event,
	type,
	members,
	selfId,
	selfRole,
	onAmended,
}: {
	/** The corpus, so a citation reads as a name rather than an id (#121). */
	agreements: VersionedAgreement[];
	/** The store, for the same reason on the other citing kind (#194). */
	rewards: VersionedRewardItem[];
	now: number;
	event: EventView;
	/** The event's type schema, or undefined for a type the couple has since dropped. */
	type: EventType | undefined;
	members: RoleMember[];
	selfId: string | null;
	selfRole: Role | null;
	onAmended?: () => void;
}) {
	const [trace, setTrace] = useState<TraceRow[] | null>(null);
	// Which chain rows are an effect this viewer could still waive (ADR 0016): the
	// shared `standingEffects` fold, so the affordance appears exactly where the
	// server would accept the write. A viewer who may not author rules sees none —
	// the same gate `amendment-validation` applies, asked once here.
	const standing = useMemo(() => {
		if (trace === null || !canWaiveEffects(selfRole)) {
			return new Map<number, WaivedEffect>();
		}
		return new Map(
			standingEffects(trace).flatMap((row) => {
				const effect = waivedEffectOf(row);
				return effect === null ? [] : [[row.id, effect] as const];
			}),
		);
	}, [trace, selfRole]);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Per-row: the stream renders one of these per event, so `aria-controls` has
	// to name this row's drill-in rather than some other row's (#148).
	const chainId = useId();

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

	const label = type?.label ?? event.type;
	// A minted ref is machine identity, not content — nobody learns anything from
	// `01JB6X…`, and nobody can act on it. The composer already hides these on the
	// way in (ADR 0005); this is the same rule on the way out. The export still
	// serializes every key, so the consent record stays whole.
	const meta = readableMetadata(type, event.composite_metadata);
	// What the viewer's partner has said back about the viewer's own event: the
	// in-force ruling (amendments arrive in created_at order, so the last
	// adjudication is the current one) and every response landed on it (#183).
	// Drives the reveal below.
	//
	// Responses belong here and not only in the chain drill-in, because the count
	// they now raise has to be clearable: `ackUpdates` fires on the reveal tap and
	// nowhere else, so a response on an entry that carries no ruling — a journal
	// entry, an act — would otherwise leave a badge nobody could ever put down.
	// Superseded rulings stay out: what is delivered is the decision in force, not
	// its drafting history. The chain is where the corrections are.
	const received =
		selfId !== null && event.actor === selfId && !event.retracted
			? [
					...event.amendments
						.filter((a) => a.kind === "adjudication")
						.slice(-1),
					...event.amendments.filter((a) => a.kind === "response"),
				].sort((a, b) => a.created_at - b.created_at)
			: [];

	return (
		<li className="py-3">
			<button
				type="button"
				className="flex w-full items-start justify-between gap-3 text-left"
				aria-expanded={open}
				aria-controls={chainId}
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
						{/* Authorship and aboutness are separate axes (ADR 0003): show the
						    subject only when it differs from who typed it, so self-subject
						    events stay uncluttered while "logged by the sub, about the dom"
						    never blurs. */}
						logged by {memberLabel(event.actor, members)}
						{event.subject && event.subject !== event.actor && (
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
									{type?.metadata[key]?.label ?? key}:{" "}
									{readMetaValue(
										type,
										key,
										value,
										event.occurred_at,
										agreements,
										rewards,
										now,
									)}
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

			{canRespondTo(event, selfId) && (
				<RespondAction eventId={event.id} onAmended={onAmended} />
			)}

			{received.length > 0 && (
				<UpdateReveal lines={received.map(describeAmendment)} />
			)}

			{open && (
				<div
					id={chainId}
					className="mt-2 space-y-3 rounded-md border bg-muted/40 p-3"
				>
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
								// The corpus and the store ride along so a crossing names the term
								// it cites (ADR 0015) and a price crossing names the item it made
								// affordable (ADR 0017), rather than either id — the same two the
								// event's own citing refs render through, two lines up.
								const line = describeTraceRow(row, {
									agreements,
									rewards,
									now,
								});
								const isNearMiss = line.tone === "near_miss";
								// A declined reversal reads muted like a near-miss — both record
								// something that did not happen — but keeps the effect bullet,
								// because the effect *did* happen and is still standing. The "○"
								// means "this rule never fired", which is the one thing this row
								// must not be read as (CONTEXT, **Effect**).
								const isDeclined = line.tone === "declined";
								const waivable = standing.get(row.id);
								return (
									<li
										key={row.id}
										className={
											isNearMiss || isDeclined ? "italic opacity-70" : undefined
										}
									>
										{isNearMiss ? "○ " : "• "}
										{line.summary}
										{line.note ? ` — ${line.note}` : ""}
										{/* The standalone waiver entry point (ADR 0016). It lives
										    on the chain rather than the row's action bar because
										    what is waived is one *effect*, and this is the only
										    place the effects are individually visible. */}
										{waivable && (
											<WaiveAction
												eventId={event.id}
												effect={waivable}
												onWaived={() => {
													// Re-fetch on next open: the waiver wrote rows this
													// list has not seen, and one of them is the reason
													// this effect is no longer standing.
													setTrace(null);
													setOpen(false);
													onAmended?.();
												}}
											/>
										)}
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
 * Waives one landed effect from the chain (ADR 0016) — the after-the-fact
 * mechanic, for the unconditional rules that fire at append (`R2:
 * ritual_completed AND late=true → demerits +1`) where there was never a confirm
 * sheet to uncheck.
 *
 * A two-tap inline confirm, like retraction: the effect either reverses or files
 * a row saying it could not, and neither is something to do by mis-tap. What the
 * server decides is deliberately *not* predicted here — whether the inverse still
 * commutes is a question about the trace, and answering it twice is how a screen
 * starts promising an outcome the ledger then declines.
 */
function WaiveAction({
	eventId,
	effect,
	onWaived,
}: {
	eventId: string;
	effect: WaivedEffect;
	onWaived: () => void;
}) {
	const [armed, setArmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function waive() {
		setBusy(true);
		setError(null);
		try {
			await amendEvent({
				kind: "waiver",
				target_event_id: eventId,
				waived: [effect],
			});
			onWaived();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't waive that.");
			setBusy(false);
			setArmed(false);
		}
	}

	if (!armed) {
		return (
			<>
				<Button
					variant="ghost"
					size="xs"
					className="ml-2"
					onClick={() => setArmed(true)}
				>
					Waive
				</Button>
				{error && <span className="ml-2 text-destructive">{error}</span>}
			</>
		);
	}
	return (
		<span className="ml-2 inline-flex flex-wrap items-center gap-2">
			<span className="text-muted-foreground">
				Waive this effect? It reverses where it still can, and the log says so
				either way.
			</span>
			<InlineConfirm
				label="Yes, waive"
				size="xs"
				tone="neutral"
				busy={busy}
				onConfirm={waive}
				onCancel={() => setArmed(false)}
			/>
		</span>
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
					<InlineConfirm
						label="Yes, retract"
						busy={busy}
						onConfirm={retract}
						onCancel={() => setMode("idle")}
					/>
				</div>
			)}

			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

/**
 * Respond to a partner's entry from the log (#183).
 *
 * A `response` has been implemented server-side since ADR 0001 and reachable from
 * exactly one screen — the conversation-flags reply — so the dom could react to
 * "I want to talk" and to nothing else the sub ever wrote. This is the affordance
 * everywhere else, and it matters more now that an act carries `awaiting: []`
 * (#182): a response is the *only* way the dom engages with an act at all.
 *
 * Which rows get it is {@link canRespondTo}'s question, not this component's —
 * see there for why the gate is authorship and visibility rather than a list of
 * respondable types.
 */
function RespondAction({
	eventId,
	onAmended,
}: {
	eventId: string;
	onAmended?: () => void;
}) {
	const [open, setOpen] = useState(false);

	if (!open) {
		return (
			<Button
				variant="outline"
				size="sm"
				className="mt-2"
				onClick={() => setOpen(true)}
			>
				Respond
			</Button>
		);
	}

	return (
		<ResponseComposer
			eventId={eventId}
			submitLabel="Respond"
			onCancel={() => setOpen(false)}
			onResponded={() => {
				setOpen(false);
				onAmended?.();
			}}
		/>
	);
}

/**
 * The sub-side reveal (handoff §8, "Sub side"): receiving a ruling is emotionally
 * load-bearing, so the dom's decision is not dumped inline — it sits behind a
 * content-safe "You have an update" until the sub chooses to open it, a small
 * deliberate interaction. Shown on the author's own event.
 *
 * A partner's `response` is delivered the same way (#183). The argument is
 * verbatim the same one: "proud of you" written on the sub's act is the moment
 * the spec calls emotionally load-bearing, and it should land as a moment rather
 * than as text already on screen when they scrolled past.
 *
 * Revealing is also what marks updates *seen* (#136): the tap is the moment the
 * sub actually receives it, so acknowledging on page load instead would clear
 * their signal before they had read anything — which is what this button exists
 * to prevent.
 *
 * The watermark is per-member and time-based, so revealing one update marks any
 * others already landed as seen too. Per-event read state would be finer and is
 * not built; the coarse version is chosen over acking on load, which was simply
 * wrong.
 */
function UpdateReveal({ lines }: { lines: AmendmentLine[] }) {
	const [revealed, setRevealed] = useState(false);

	if (!revealed) {
		return (
			<Button
				variant="outline"
				size="sm"
				className="mt-2"
				onClick={() => {
					setRevealed(true);
					// A failed ack leaves the count up: telling someone twice beats
					// marking an update seen that never reached the server.
					ackUpdates().catch(() => {});
				}}
			>
				You have an update — reveal
			</Button>
		);
	}

	return (
		<div className="mt-2 space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
			{lines.map((line) => (
				<div key={`${line.at}-${line.tone}`}>
					<p className="font-medium">{line.summary}</p>
					{line.note && (
						<p className="mt-1 italic text-muted-foreground">“{line.note}”</p>
					)}
				</div>
			))}
		</div>
	);
}

/**
 * One metadata value as a person should read it.
 *
 * A **citing ref** holds an Agreement id, and ADR 0005 already named the cost of
 * that shape: "a ref stops being readable… every surface that displays a
 * `task_id` must display the name instead." Tasks solved it with a `task_name`
 * beside the id; a citation can't, because the name lives in the corpus and
 * versions over time — so it is resolved here, at the moment the act happened
 * (#121, story 23).
 *
 * Falls back to the raw value when the id names nothing the couple holds: a
 * free-text citation logged before the pack change, or a term hard-deleted while
 * uncited. An opaque id is a worse answer than a name and a better one than a
 * blank.
 *
 * Everything that is not a citation reads through {@link displayMetaValue}, which
 * is where an enum picks up the display copy its control offered (#155).
 */
function readMetaValue(
	type: EventType | undefined,
	key: string,
	value: MetadataValue,
	occurredAt: number,
	agreements: VersionedAgreement[],
	rewards: VersionedRewardItem[],
	now: number,
): string {
	const field = type?.metadata[key];
	if (field && isCitingRef(field) && typeof value === "string") {
		// Which definition set the ref names is already stated in the schema, so it
		// picks the describer rather than a flag doing it — the same derivation
		// `isCitingRef` itself makes. Both describers render the name **as it stood
		// when the act happened**, with today's beside it when they differ.
		const cited =
			field.kind === "ref" && field.ref_kind === REWARD_REF_KIND
				? describeRewardCitation(rewards, value, occurredAt, now)
				: describeCitation(agreements, value, occurredAt, now);
		return cited ?? formatMetaValue(value);
	}
	return displayMetaValue(field, value);
}
