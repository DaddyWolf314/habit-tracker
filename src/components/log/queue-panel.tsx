import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { amendEvent } from "#/lib/api.ts";
import { type AwaitedRuling, awaitedRulings } from "#/shared/adjudication.ts";
import type { AnchorView } from "#/shared/anchors.ts";
import { reevaluate, rulesEffectiveAt } from "#/shared/engine.ts";
import {
	awaitingKeysFor,
	type EventType,
	type MetadataField,
} from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import {
	type MetadataValue,
	type Role,
	subjectRoleOf,
} from "#/shared/roles.ts";
import type { VersionedRule } from "#/shared/rules.ts";
import { anchorLabel } from "#/templates/index.ts";
import {
	elapsedDaysText,
	formatElapsed,
	formatMetaValue,
	formatTime,
	memberLabel,
	summarizeEffectOp,
} from "./formatting.ts";

const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

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
	selfRole,
	onAmended,
}: {
	events: EventView[];
	types: EventType[];
	rules: VersionedRule[];
	members: RoleMember[];
	anchors: AnchorView[];
	selfRole: Role | null;
	onAmended: () => void;
}) {
	const typeMap = new Map(types.map((t) => [t.id, t]));
	const queue = events.flatMap((event) => {
		const type = typeMap.get(event.type);
		if (!type) return [];
		// Subject-qualified awaiting entries (ADR 0003) ask for no ruling when the
		// event's subject doesn't match — resolved through the same seam the DO uses.
		const subjectRole = subjectRoleOf(event.subject, members);
		const rulings = awaitedRulings(event, type, selfRole, subjectRole);
		return rulings.length > 0 ? [{ event, type, rulings }] : [];
	});

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
	onAmended,
}: {
	event: EventView;
	type: EventType;
	rules: VersionedRule[];
	rulings: AwaitedRuling[];
	members: RoleMember[];
	anchors: AnchorView[];
	onAmended: () => void;
}) {
	// Effective-dating keys off the target event's log-time, never the viewing
	// time (ADR 0002) — the same resolution the DO's reevaluateOnAmendment
	// applies on commit, so the preview and the evidence can't cite a rule
	// version that won't actually govern the ruling.
	const rulesInForce = rulesEffectiveAt(rules, event.logged_at);
	const [values, setValues] = useState<Record<string, string>>({});
	const [note, setNote] = useState("");
	const [stage, setStage] = useState<"edit" | "confirm">("edit");
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
	 * against what already fired — exactly what the DO applies on commit. Visibility
	 * only; no effect-waiving (a scoring-layer concern).
	 */
	function previewEffects(): string[] {
		// Same resolution seam the DO uses (ADR 0003), so the preview and the
		// commit agree on which subject-qualified rules and awaiting entries apply.
		const subjectRole = subjectRoleOf(event.subject, members);
		const before = {
			type: event.type,
			metadata: event.composite_metadata,
			occurred_at: event.occurred_at,
			subject_role: subjectRole,
			awaiting: awaitingKeysFor(type.awaiting, subjectRole),
		};
		const after = {
			...before,
			metadata: { ...event.composite_metadata, ...patch },
		};
		return reevaluate(rulesInForce, before, after).flatMap((fired) =>
			fired.ops.map(summarizeEffectOp),
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

	const context = Object.entries(event.composite_metadata);
	const effects = stage === "confirm" ? previewEffects() : [];

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
						<span className="text-xs text-muted-foreground">
							Note (optional)
						</span>
						<Textarea
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
						This ruling will fire:
					</p>
					{effects.length > 0 ? (
						<ul className="space-y-1 text-sm">
							{effects.map((effect, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a static, order-stable list rebuilt each render; two rules can phrase identically, so content is not a unique key
								<li key={`${effect}-${i}`}>• {effect}</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">
							No mechanical effects — this only records the ruling.
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
							{o}
						</Button>
					))}
				</div>
			</div>
		);
	}

	return (
		<div>
			{label}
			<input
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
