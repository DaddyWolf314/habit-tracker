import { type ReactNode, useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { fieldClass } from "#/components/ui/field.ts";
import { Textarea } from "#/components/ui/textarea.tsx";
import {
	VISIBILITY_LABEL,
	VisibilitySelect,
} from "#/components/visibility-select.tsx";
import { logEvent } from "#/lib/api.ts";
import type { VersionedAgreement } from "#/shared/agreements.ts";
import {
	awaitingKeysFor,
	type EventType,
	type MetadataField,
} from "#/shared/event-types.ts";
import type { LogEventInput } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { OpenPromptView } from "#/shared/journaling.ts";
import { type RefCandidate, refCandidates } from "#/shared/ref-candidates.ts";
import { isOriginatingRef } from "#/shared/refs.ts";
import {
	type MetadataValue,
	subjectRoleOf,
	type Visibility,
} from "#/shared/roles.ts";
import type { Rule } from "#/shared/rules.ts";
import { formatRemaining, type TimerView } from "#/shared/timers.ts";

const labelClass = "text-xs text-muted-foreground";

/** The ghost-button styling both of the ref picker's mode switches share. */
const switchClass = "mt-1 h-auto p-0 text-xs";

/**
 * Log-an-event sheet (handoff §9 surface 4). The type picker offers the couple's
 * human-facing types (the reserved `counter_*` sugar is filtered out server-
 * and client-side); the metadata form is generated from the selected type's
 * schema. Leaving an `awaiting` key blank is allowed — that is what makes the
 * event land as pending.
 */
export function LogComposer({
	types,
	members,
	openPrompts,
	rules,
	timers,
	agreements,
	onLogged,
}: {
	types: EventType[];
	members: RoleMember[];
	/** The caller's outstanding prompts, feeding the answer picker (#102). */
	openPrompts: OpenPromptView[];
	/** The rules in force, which say which refs echo an existing id (#89). */
	rules: Rule[];
	/** The timers an echoing ref's candidates are drawn from (#89). */
	timers: TimerView[];
	/** The corpus a citing ref's candidates are drawn from (#121, ADR 0006). */
	agreements: VersionedAgreement[];
	onLogged: () => void;
}) {
	const pickable = useMemo(
		() => types.filter((t) => !t.id.startsWith("counter_")),
		[types],
	);
	const [typeId, setTypeId] = useState<string>("");
	const [subject, setSubject] = useState<string>("");
	const [note, setNote] = useState("");
	const [meta, setMeta] = useState<Record<string, string>>({});
	// Unset, not `shared` (#94): the author *always* chooses explicitly (ADR 0001),
	// so there is no preselection to log by not touching the control.
	const [visibility, setVisibility] = useState<Visibility | "">("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const type = pickable.find((t) => t.id === typeId);

	function reset() {
		setSubject("");
		setNote("");
		setMeta({});
		setVisibility("");
	}

	function selectType(id: string) {
		setTypeId(id);
		reset();
	}

	/** Coerces the string form values into typed metadata, dropping blanks. */
	function buildMetadata(t: EventType): Record<string, MetadataValue> {
		const out: Record<string, MetadataValue> = {};
		for (const [key, field] of Object.entries(t.metadata)) {
			const raw = meta[key];
			if (raw === undefined || raw === "") continue;
			if (field.kind === "boolean") out[key] = raw === "yes";
			else if (field.kind === "number") out[key] = Number(raw);
			else out[key] = raw;
		}
		return out;
	}

	/**
	 * The awaited keys in force for the currently-chosen subject (ADR 0003):
	 * a subject-qualified entry defers its key only when the subject matches, so
	 * the "leave blank to defer" hint and the required check track the picker.
	 */
	const awaitedKeys = useMemo(() => {
		if (!type) return new Set<string>();
		const subjectRole = subjectRoleOf(subject || undefined, members);
		return new Set(awaitingKeysFor(type.awaiting, subjectRole));
	}, [type, subject, members]);

	/**
	 * The candidates each of the selected type's ref fields can name (#89),
	 * derived from the rules: a ref this event would *close* a timer on echoes an
	 * id minted elsewhere, so it is a pick, not a transcription. Recomputed when
	 * the timer list refreshes, so the remaining/elapsed time in each option's
	 * label re-times on the log's poll cadence — an option is a thing to
	 * recognize, not a clock, so it doesn't tick per second like a Today row.
	 */
	const candidates = useMemo(() => {
		const now = Date.now();
		const byKey = new Map<string, RefCandidate[]>();
		if (!type) return byKey;
		for (const [key, field] of Object.entries(type.metadata)) {
			if (field.kind !== "ref") continue;
			byKey.set(
				key,
				refCandidates({
					rules,
					timers,
					typeId: type.id,
					key,
					now,
					// A citing ref draws from the corpus rather than the timers, and
					// needs the field to know which kind (if any) it narrows to.
					field,
					agreements,
				}),
			);
		}
		return byKey;
	}, [type, rules, timers, agreements]);

	/** Required fields (non-`awaiting`) the user hasn't filled in yet. */
	function missingRequired(t: EventType): string[] {
		const missing: string[] = [];
		if (t.subject_required && !subject) missing.push("Subject");
		// Visibility is required on the types that carry it, for the same reason
		// nothing preselects it: an unmade choice must not resolve to the most
		// exposed level (#94). Non-journaling types have no choice to make.
		if (t.journaling && !visibility) missing.push("Visibility");
		for (const [key, field] of Object.entries(t.metadata)) {
			if (isOriginatingRef(field)) continue;
			if (field.required && !awaitedKeys.has(key) && !(meta[key] ?? "")) {
				missing.push(field.label);
			}
		}
		return missing;
	}

	async function submit() {
		if (!type) return;
		const missing = missingRequired(type);
		if (missing.length > 0) {
			setError(`Please fill in: ${missing.join(", ")}.`);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const input: LogEventInput = {
				type: type.id,
				subject: subject || undefined,
				metadata: buildMetadata(type),
				note: note.trim() || undefined,
				// Only a journaling-capable type carries a real choice; everything else
				// is always shared (the server rejects any other value on it). The
				// unchosen case is refused above, so this never defaults a journaling
				// entry to the most exposed level (#94).
				visibility: type.journaling && visibility ? visibility : "shared",
			};
			await logEvent(input);
			setTypeId("");
			reset();
			onLogged();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't log that.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3">
			<Field label="Type">
				<select
					className={`${fieldClass} mt-1`}
					value={typeId}
					onChange={(e) => selectType(e.target.value)}
				>
					<option value="">Choose a type…</option>
					{pickable.map((t) => (
						<option key={t.id} value={t.id}>
							{t.label}
						</option>
					))}
				</select>
			</Field>

			{type && (
				<div className="space-y-3">
					<Field label={`Subject${type.subject_required ? " (required)" : ""}`}>
						<select
							className={`${fieldClass} mt-1`}
							value={subject}
							onChange={(e) => setSubject(e.target.value)}
						>
							<option value="">—</option>
							{members.map((m) => (
								<option key={m.member_id} value={m.member_id}>
									{m.is_self ? `you (${m.role ?? "?"})` : (m.role ?? "partner")}
								</option>
							))}
						</select>
					</Field>

					{/* An originating ref is server-minted (ADR 0005), so it is not user
					    input: the form neither renders it nor counts it against the
					    required check, and the event card hides it on the way back out. */}
					{Object.entries(type.metadata)
						.filter(([, field]) => !isOriginatingRef(field))
						.map(([key, field]) => (
							// Keyed by type *and* key so switching types remounts the inputs:
							// two types sharing a key (both sides of `session_id`) must not
							// carry the ref picker's free-text escape across the switch.
							<MetadataInput
								key={`${type.id}.${key}`}
								field={field}
								awaiting={awaitedKeys.has(key)}
								openPrompts={openPrompts}
								candidates={candidates.get(key) ?? []}
								value={meta[key] ?? ""}
								onChange={(v) => setMeta((m) => ({ ...m, [key]: v }))}
							/>
						))}

					<Field label={type.note_prompt ?? "Note"}>
						<Textarea
							className="mt-1"
							value={note}
							onChange={(e) => setNote(e.target.value)}
						/>
					</Field>

					{type.journaling && (
						<Field label={VISIBILITY_LABEL}>
							<VisibilitySelect
								className={`${fieldClass} mt-1`}
								value={visibility}
								onChange={setVisibility}
							/>
						</Field>
					)}

					{error && <p className="text-sm text-destructive">{error}</p>}

					<Button onClick={submit} disabled={busy}>
						{busy ? "…" : "Log it"}
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * One labelled form row. The label element wraps its control, so the caption is
 * the control's accessible name and tapping it focuses the field — the composer
 * is a phone surface, and these are the smallest targets on it.
 */
function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
	return (
		<div>
			{/** biome-ignore lint/a11y/noLabelWithoutControl: the control is `children` */}
			<label className="block">
				<span className={labelClass}>{label}</span>
				{children}
			</label>
		</div>
	);
}

/** One schema-driven metadata input, rendered by kind (handoff §5). */
function MetadataInput({
	field,
	awaiting,
	openPrompts,
	candidates,
	value,
	onChange,
}: {
	field: MetadataField;
	awaiting: boolean;
	openPrompts: OpenPromptView[];
	/** Live ids this ref field can name, empty for every other kind (#89). */
	candidates: RefCandidate[];
	value: string;
	onChange: (value: string) => void;
}) {
	const label = (
		<>
			{field.label}
			{field.required && !awaiting && (
				<span className="ml-1 text-destructive">(required)</span>
			)}
			{awaiting && (
				<span className="ml-1 text-amber-600">
					(awaiting — leave blank to defer)
				</span>
			)}
		</>
	);

	// Answering a prompt is a pick, not a transcription (#102): the options are
	// the caller's outstanding prompts, so the submitted ref always names a real
	// prompt — no hand-typed id, no typo that silently never pairs. Blank stays
	// legal: a `journal_entry` with no ref is self-directed journaling.
	if (field.kind === "ref" && field.ref_kind === "prompt") {
		return (
			<Field label={label}>
				<select
					className={`${fieldClass} mt-1`}
					value={value}
					onChange={(e) => onChange(e.target.value)}
				>
					<option value="">— (not answering a prompt)</option>
					{openPrompts.map((p) => (
						<option key={p.prompt_id} value={p.prompt_id}>
							{promptOptionLabel(p)}
						</option>
					))}
				</select>
			</Field>
		);
	}

	// Every other echoing ref is a pick too (#89) — same reasoning, one rung more
	// general: the candidates come from the rules. A ref with none (an
	// originating ref, or one nothing outstanding answers to) falls through to
	// the text input below.
	if (field.kind === "ref" && candidates.length > 0) {
		return (
			<RefPicker
				label={label}
				candidates={candidates}
				value={value}
				onChange={onChange}
			/>
		);
	}

	if (field.kind === "boolean" || field.kind === "enum") {
		const options = field.kind === "boolean" ? ["yes", "no"] : field.options;
		return (
			<Field label={label}>
				<select
					className={`${fieldClass} mt-1`}
					value={value}
					onChange={(e) => onChange(e.target.value)}
				>
					<option value="">—</option>
					{options.map((o) => (
						<option key={o} value={o}>
							{o}
						</option>
					))}
				</select>
			</Field>
		);
	}

	return (
		<Field label={label}>
			<input
				className={`${fieldClass} mt-1`}
				type={field.kind === "number" ? "number" : "text"}
				min={field.kind === "number" ? field.min : undefined}
				max={field.kind === "number" ? field.max : undefined}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</Field>
	);
}

/**
 * An echoing ref with candidates (#89): a select over the timers this event
 * could close, plus an escape to free text. The escape is not a formality — a
 * task whose countdown expired past the grace window, or one assigned before
 * the couple had countdowns, has no candidate left, and refusing to log it
 * would be worse than the typo the picker prevents. It is a button rather than
 * an option in the list so the picker's value space stays pure ids: no sentinel
 * a real task name could ever collide with.
 */
function RefPicker({
	label,
	candidates,
	value,
	onChange,
}: {
	label: ReactNode;
	candidates: RefCandidate[];
	value: string;
	onChange: (value: string) => void;
}) {
	const [manual, setManual] = useState(false);

	function swap(toManual: boolean) {
		setManual(toManual);
		// Clear on the way through: a value carried into the other mode would show
		// as blank there (an off-list id has no option to select), and a ref you
		// can't see is exactly what this picker exists to stop.
		onChange("");
	}

	if (manual) {
		return (
			<div>
				<Field label={label}>
					<input
						className={`${fieldClass} mt-1`}
						type="text"
						value={value}
						onChange={(e) => onChange(e.target.value)}
					/>
				</Field>
				<Button
					variant="ghost"
					size="sm"
					className={switchClass}
					onClick={() => swap(false)}
				>
					Pick from the list instead
				</Button>
			</div>
		);
	}

	// A picked candidate can vanish under an open sheet — the log refreshes on a
	// poll, and the partner may have closed that very timer. Keep the chosen id as
	// an option of its own so the select never reads blank while the form still
	// holds a value: the author sees what they are about to log, and that it is
	// no longer offered.
	const known = candidates.some((c) => c.value === value);

	return (
		<div>
			<Field label={label}>
				<select
					className={`${fieldClass} mt-1`}
					value={value}
					onChange={(e) => onChange(e.target.value)}
				>
					<option value="">—</option>
					{candidates.map((c) => (
						<option key={c.value} value={c.value}>
							{c.label}
						</option>
					))}
					{value !== "" && !known && (
						<option value={value}>{value} — no longer offered</option>
					)}
				</select>
			</Field>
			<Button
				variant="ghost"
				size="sm"
				className={switchClass}
				onClick={() => swap(true)}
			>
				Type an id in instead
			</Button>
		</div>
	);
}

/**
 * One picker option: the question itself, with its countdown state as urgency.
 * An overdue prompt stays pickable (#102) — a late answer still pairs for
 * history, it just no longer discharges the countdown.
 */
function promptOptionLabel(p: OpenPromptView): string {
	const question =
		p.question && p.question.length > 60
			? `${p.question.slice(0, 57)}…`
			: (p.question ?? "(no question)");
	if (p.expired) return `${question} — overdue`;
	if (p.paused) return `${question} — paused`;
	if (p.deadline_at === null) return question;
	return `${question} — ${formatRemaining(p.deadline_at - Date.now())} left`;
}
