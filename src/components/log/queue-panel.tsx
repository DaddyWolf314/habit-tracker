import { useId, useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { fieldClass } from "#/components/ui/field.ts";
import { Textarea } from "#/components/ui/textarea.tsx";
import { amendEvent } from "#/lib/api.ts";
import { type AwaitedRuling, queueFor } from "#/shared/adjudication.ts";
import { type WaivedEffect, waivedEffectKey } from "#/shared/amendments.ts";
import { type AnchorView, elapsedDaysText } from "#/shared/anchors.ts";
import { type Counter, counterValuesOf } from "#/shared/counters.ts";
import { reevaluate, rulesEffectiveAt } from "#/shared/engine.ts";
import {
	awaitingKeysFor,
	type EventType,
	type MetadataField,
	optionLabel,
} from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { readableMetadata } from "#/shared/refs.ts";
import {
	type MetadataValue,
	type Role,
	subjectRoleOf,
} from "#/shared/roles.ts";
import type { VersionedRule } from "#/shared/rules.ts";
import {
	activeTimerDefinitionsAt,
	spansOf,
	type TimerSpan,
	type TimerView,
} from "#/shared/timers.ts";
import { anchorLabel } from "#/templates/index.ts";
import {
	displayMetaValue,
	formatElapsed,
	formatTime,
	memberLabel,
	summarizeEffectOp,
} from "./formatting.ts";

/**
 * The adjudication queue, dom side (handoff §4.2, §8, §9 surface 3). Every
 * pending event with a key this member is `adjudicated_by` for surfaces here
 * waiting on a ruling. Submitting a ruling is an `adjudication` amendment — it
 * patches only the awaited keys, and the engine re-evaluates the event so any
 * rule that was waiting on that key fires. Before commit the dom sees a confirm
 * sheet listing the mechanical fallout (the same `reevaluate` the DO applies,
 * run here over the couple's `rules`). Empty (and hidden) when nothing awaits.
 */
export function QueuePanel({
	events,
	types,
	rules,
	members,
	anchors,
	timers,
	counters,
	selfRole,
	onAmended,
}: {
	events: EventView[];
	types: EventType[];
	rules: VersionedRule[];
	members: RoleMember[];
	anchors: AnchorView[];
	timers: TimerView[];
	counters: Counter[];
	selfRole: Role | null;
	onAmended: () => void;
}) {
	// The same fold Today's queue entry counts (#136): two derivations of "what
	// awaits my ruling" would eventually disagree about what counts.
	const queue = queueFor({ events, types, members, role: selfRole });

	// The timer spans the preview resolves ambient state from (ADR 0011). Mapped
	// once here rather than per card: each card asks the shared predicate for its
	// own event's moment, which is the same question the DO will ask on commit.
	const spans = useMemo(() => spansOf(timers), [timers]);

	// The score the preview resolves `counter_value` from (ADR 0015). Every card
	// reads the same map because every card's ruling would be committed against the
	// same live counters — a `counter_value` clause is evaluated at *ruling* time,
	// not at the target event's moment, so unlike the spans above there is nothing
	// per-event to ask.
	const counterValues = useMemo(() => counterValuesOf(counters), [counters]);

	if (queue.length === 0) return null;

	return (
		<section className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
			<h2 className="text-lg font-semibold">
				Awaiting your ruling
				<span className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-800">
					{queue.length}
				</span>
			</h2>
			<ul className="mt-3 space-y-3">
				{queue.map(({ event, type, rulings }) => (
					<QueueItem
						key={event.id}
						event={event}
						type={type}
						rules={rules}
						rulings={rulings}
						members={members}
						anchors={anchors}
						spans={spans}
						counterValues={counterValues}
						onAmended={onAmended}
					/>
				))}
			</ul>
		</section>
	);
}

function QueueItem({
	event,
	type,
	rules,
	rulings,
	members,
	anchors,
	spans,
	counterValues,
	onAmended,
}: {
	event: EventView;
	type: EventType;
	rules: VersionedRule[];
	rulings: AwaitedRuling[];
	members: RoleMember[];
	anchors: AnchorView[];
	spans: TimerSpan[];
	counterValues: ReadonlyMap<string, number>;
	onAmended: () => void;
}) {
	// Effective-dating keys off the target event's log-time, never the viewing
	// time (ADR 0002) — the same resolution the DO's reevaluateOnAmendment
	// applies on commit, so the preview and the evidence can't cite a rule
	// version that won't actually govern the ruling.
	const rulesInForce = rulesEffectiveAt(rules, event.logged_at);
	const [values, setValues] = useState<Record<string, string>>({});
	// One of these per queued event, so the id has to be per-instance (#148).
	const noteId = useId();
	const [note, setNote] = useState("");
	const [stage, setStage] = useState<"edit" | "confirm">("edit");
	// The effects the dom has unchecked on the sheet, by `rule#index` (ADR 0016).
	// Kept across a trip back to "edit" on purpose — an intent to let something go
	// survives re-picking a value — and made safe by `commit` sending only keys
	// still present in the current preview.
	const [waived, setWaived] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [dismissing, setDismissing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** The awaited keys the dom has actually decided, coerced to typed values. */
	function buildPatch(): Record<string, MetadataValue> {
		const patch: Record<string, MetadataValue> = {};
		for (const { key, field } of rulings) {
			const raw = values[key];
			if (raw === undefined || raw === "") continue;
			if (field.kind === "boolean") patch[key] = raw === "yes";
			else if (field.kind === "number") patch[key] = Number(raw);
			else patch[key] = raw;
		}
		return patch;
	}

	const patch = buildPatch();
	const ready = Object.keys(patch).length > 0;

	/**
	 * The forward-running effects this ruling would fire (handoff §8, step 4):
	 * re-run the pure engine over the target with the ruling merged in and diff
	 * against what already fired — exactly what the DO applies on commit.
	 *
	 * Each line is a checkbox (ADR 0016). Unchecking one waives it, and waiving on
	 * this sheet **suppresses**: the effect is never applied, so the counter's
	 * history carries no peak that never existed. Each carries the `(rule_id,
	 * effect_index)` pair the server needs to suppress exactly the same effect —
	 * the phrase is for the dom, the pair is for the ledger.
	 */
	function previewEffects(): WaivableEffect[] {
		// Same resolution seam the DO uses (ADR 0003), so the preview and the
		// commit agree on which subject-qualified rules and awaiting entries apply.
		const subjectRole = subjectRoleOf(event.subject, members);
		const before = {
			type: event.type,
			metadata: event.composite_metadata,
			occurred_at: event.occurred_at,
			subject_role: subjectRole,
			// As of the event, not of now (ADR 0011): a ruling a week late still asks
			// what was running when the act happened, so an escalation lands if the
			// denial *was* on — the same `occurred_at` clock the anchor resets below
			// already use. The same shared predicate the DO applies on commit.
			active_timers: activeTimerDefinitionsAt(spans, event.occurred_at),
			// The score *now*, not as of the event (ADR 0015). A `counter_value` clause
			// reads what the engine sees when it acts, and for a ruling that is the
			// moment of the ruling — so the sheet and the DO's commit read the same
			// number, which is the whole reason the counters are shipped to this
			// surface at all.
			counter_values: counterValues,
			awaiting: awaitingKeysFor(type.awaiting, subjectRole),
		};
		const after = {
			...before,
			metadata: { ...event.composite_metadata, ...patch },
		};
		return reevaluate(rulesInForce, before, after).flatMap((fired) =>
			fired.ops
				.map((op, index) => ({
					rule_id: fired.rule_id,
					effect_index: index,
					// Kept so the filter below can drop skips *after* the index is
					// assigned: the index is the effect's position in the rule's own list
					// (ADR 0016), and re-numbering it around a skipped effect would have a
					// waiver name the wrong one.
					op,
				}))
				// An effect that routed no magnitude resolves to nothing (ADR 0015), so
				// there is nothing to offer a waiver on — a checkbox here would let the
				// dom overrule a change that was never going to happen. The DO still
				// files its trace note, which is where the fact belongs.
				.filter(({ op }) => op.kind !== "skipped")
				.map(({ rule_id, effect_index, op }) => ({
					rule_id,
					effect_index,
					phrase: summarizeEffectOp(op),
				})),
		);
	}

	async function commit() {
		setBusy(true);
		setError(null);
		try {
			await amendEvent({
				kind: "adjudication",
				target_event_id: event.id,
				patch,
				note: note.trim() || undefined,
				// Only what is actually on this sheet: a stale key left in the set by a
				// re-edit would name an effect the ruling no longer fires, which the
				// server refuses outright rather than silently ignoring. Omitted
				// entirely when nothing is waived, so an ordinary ruling never carries
				// an empty waiver through the authoring gate.
				waive: waivedNow.length > 0 ? waivedNow : undefined,
			});
			// Post-ruling: the card animates out, then the log refetch drops it.
			setDismissing(true);
			onAmended();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't record the ruling.",
			);
			setBusy(false);
		}
	}

	// Same rule as the event card (ADR 0005): a minted ref is machine identity, so
	// it is not context for a ruling — the dom judges the name, the note, and the
	// awaited key, none of which is a ULID.
	const context = readableMetadata(type, event.composite_metadata);
	const effects = stage === "confirm" ? previewEffects() : [];
	const waivedNow = effects
		.filter((effect) => waived.has(waivedEffectKey(effect)))
		.map(({ rule_id, effect_index }) => ({ rule_id, effect_index }));

	// Adjudication evidence (#78, ADR 0003): the anchors this event type's rules
	// can reset are the anchors the ruling is judged against — for an orgasm,
	// "since sub's last" and "since dom's last" side by side, so "was this
	// permitted" is ruled with the protocol state on screen. Derived from the
	// rule versions in force at the event's log-time (disabled ones excluded —
	// they can't fire), so custom types get the same evidence for free and a
	// since-changed rule can't inject stale chips.
	const evidence = (() => {
		const relevant = new Set(
			rulesInForce
				.filter((r) => r.enabled !== false && r.condition.type === event.type)
				.flatMap((r) => r.effects)
				.flatMap((e) => (e.verb === "reset_anchor" ? [e.anchor] : [])),
		);
		return anchors.filter((a) => relevant.has(a.anchor));
	})();

	return (
		<li
			className={`rounded-md border bg-background p-3 transition-opacity duration-200 ${
				dismissing ? "opacity-0" : ""
			}`}
		>
			<div className="flex items-baseline justify-between gap-2">
				<span className="text-sm font-medium">{type.label}</span>
				<span className="text-right text-xs text-muted-foreground">
					<div>{formatTime(event.occurred_at)}</div>
					<div>waiting {formatElapsed(event.logged_at, Date.now())}</div>
				</span>
			</div>
			<div className="text-xs text-muted-foreground">
				logged by {memberLabel(event.actor, members)}
				{event.subject && event.subject !== event.actor && (
					<> · about {memberLabel(event.subject, members)}</>
				)}
			</div>
			{evidence.length > 0 && (
				<div className="mt-1 flex flex-wrap gap-1">
					{evidence.map((anchor) => (
						<span
							key={anchor.anchor}
							className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
						>
							{anchorLabel(anchor.anchor)}:{" "}
							{elapsedDaysText(anchor.elapsed_days, true)}
						</span>
					))}
				</div>
			)}
			{context.length > 0 && (
				<div className="mt-1 flex flex-wrap gap-1">
					{context.map(([key, value]) => (
						<span key={key} className="rounded bg-muted px-1.5 py-0.5 text-xs">
							{key}: {displayMetaValue(type.metadata[key], value)}
						</span>
					))}
				</div>
			)}
			{event.note && (
				<p className="mt-1 text-xs italic text-muted-foreground">
					“{event.note}”
				</p>
			)}

			{stage === "edit" ? (
				<div className="mt-3 space-y-3">
					{rulings.map(({ key, field }) => (
						<RulingInput
							key={key}
							field={field}
							value={values[key] ?? ""}
							onChange={(v) => setValues((s) => ({ ...s, [key]: v }))}
						/>
					))}
					<div>
						<label htmlFor={noteId} className="text-xs text-muted-foreground">
							Note (optional)
						</label>
						<Textarea
							id={noteId}
							className="mt-1"
							value={note}
							onChange={(e) => setNote(e.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<Button onClick={() => setStage("confirm")} disabled={!ready}>
						Review ruling
					</Button>
				</div>
			) : (
				<div className="mt-3 space-y-3 rounded-md border bg-muted/40 p-3">
					<p className="text-xs font-medium text-muted-foreground">
						This ruling will fire — uncheck anything you are letting go:
					</p>
					{effects.length > 0 ? (
						<ul className="space-y-1 text-sm">
							{effects.map((effect) => (
								<EffectCheckbox
									key={waivedEffectKey(effect)}
									effect={effect}
									fires={!waived.has(waivedEffectKey(effect))}
									onToggle={() =>
										setWaived((prev) => {
											const next = new Set(prev);
											const key = waivedEffectKey(effect);
											if (!next.delete(key)) next.add(key);
											return next;
										})
									}
								/>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">
							No mechanical effects — this only records the ruling.
						</p>
					)}
					{waived.size > 0 && (
						// Said plainly, because the mechanic is visible in the numbers: a
						// waived effect never applies, so the counter never holds the value
						// that was let go, and nothing compensates for it afterwards.
						<p className="text-xs text-muted-foreground">
							Unchecked effects never apply. The log records what each rule
							proposed and that you waived it.
						</p>
					)}
					{note.trim() && (
						<p className="text-xs italic text-muted-foreground">
							Your note: “{note.trim()}”
						</p>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex gap-2">
						<Button onClick={commit} disabled={busy}>
							{busy ? "…" : "Confirm ruling"}
						</Button>
						<Button
							variant="ghost"
							onClick={() => setStage("edit")}
							disabled={busy}
						>
							Back
						</Button>
					</div>
				</div>
			)}
		</li>
	);
}

/**
 * One line of the confirm sheet: the effect a rule would fire, phrased for the
 * dom and named for the ledger. The phrase comes from `summarizeEffectOp`, the
 * same function the chain view renders a *fired* effect with, so what the dom
 * unchecks here and what the log says they waived are the same words.
 */
interface WaivableEffect extends WaivedEffect {
	phrase: string;
}

/**
 * One effect on the confirm sheet, as a checkbox. Checked means it fires;
 * unchecking waives it (ADR 0016).
 *
 * The whole row is the label, so the tap target is the line rather than the
 * 16px box — this is a phone-first app and the box alone sits well under the
 * 44px floor (#147). `min-h-11` states that floor on the row for the same reason
 * `Button`'s default carries it.
 */
function EffectCheckbox({
	effect,
	fires,
	onToggle,
}: {
	effect: WaivableEffect;
	fires: boolean;
	onToggle: () => void;
}) {
	return (
		<li>
			<label className="flex min-h-11 cursor-pointer items-center gap-2">
				<input
					type="checkbox"
					className="size-4 shrink-0"
					checked={fires}
					onChange={onToggle}
				/>
				<span
					className={fires ? undefined : "text-muted-foreground line-through"}
				>
					{effect.phrase}
				</span>
			</label>
		</li>
	);
}

/**
 * One awaited-key control, rendered by field kind (handoff §8, step 3): boolean
 * as two large buttons, enum as a segmented control, number/text as an input.
 */
function RulingInput({
	field,
	value,
	onChange,
}: {
	field: MetadataField;
	value: string;
	onChange: (value: string) => void;
}) {
	const inputId = useId();
	const label = (
		<span className="text-xs font-medium">Rule on: {field.label}</span>
	);

	if (field.kind === "boolean" || field.kind === "enum") {
		const options = field.kind === "boolean" ? ["yes", "no"] : field.options;
		return (
			<div>
				{label}
				<div className="mt-1 flex gap-2">
					{options.map((o) => (
						<Button
							key={o}
							type="button"
							variant={value === o ? "default" : "outline"}
							className={field.kind === "boolean" ? "flex-1" : undefined}
							onClick={() => onChange(o)}
						>
							{optionLabel(field, o)}
						</Button>
					))}
				</div>
			</div>
		);
	}

	// A real label here, where the control is an input the caption is the only
	// name for; the branch above captions a pair of buttons that already name
	// themselves (#148).
	return (
		<div>
			<label htmlFor={inputId} className="text-xs font-medium">
				Rule on: {field.label}
			</label>
			<input
				id={inputId}
				className={`${fieldClass} mt-1`}
				type={field.kind === "number" ? "number" : "text"}
				min={field.kind === "number" ? field.min : undefined}
				max={field.kind === "number" ? field.max : undefined}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}
