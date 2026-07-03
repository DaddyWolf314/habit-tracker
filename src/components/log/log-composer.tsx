import { useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { logEvent } from "#/lib/api.ts";
import type { EventType, MetadataField } from "#/shared/event-types.ts";
import type { LogEventInput } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { MetadataValue } from "#/shared/roles.ts";

const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

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
	onLogged,
}: {
	types: EventType[];
	members: RoleMember[];
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
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const type = pickable.find((t) => t.id === typeId);

	function reset() {
		setSubject("");
		setNote("");
		setMeta({});
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

	async function submit() {
		if (!type) return;
		setBusy(true);
		setError(null);
		try {
			const input: LogEventInput = {
				type: type.id,
				subject: subject || undefined,
				metadata: buildMetadata(type),
				note: note.trim() || undefined,
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
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Log an event</h2>

			<div className="mt-3">
				{/** biome-ignore lint/a11y/noLabelWithoutControl: label wraps the select */}
				<label className="text-xs text-muted-foreground">Type</label>
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
			</div>

			{type && (
				<div className="mt-3 space-y-3">
					<div>
						<span className="text-xs text-muted-foreground">
							Subject{type.subject_required ? " (required)" : ""}
						</span>
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
					</div>

					{Object.entries(type.metadata).map(([key, field]) => (
						<MetadataInput
							key={key}
							field={field}
							awaiting={type.awaiting.includes(key)}
							value={meta[key] ?? ""}
							onChange={(v) => setMeta((m) => ({ ...m, [key]: v }))}
						/>
					))}

					<div>
						<span className="text-xs text-muted-foreground">
							{type.note_prompt ?? "Note"}
						</span>
						<Textarea
							className="mt-1"
							value={note}
							onChange={(e) => setNote(e.target.value)}
						/>
					</div>

					{error && <p className="text-sm text-destructive">{error}</p>}

					<Button onClick={submit} disabled={busy}>
						{busy ? "…" : "Log it"}
					</Button>
				</div>
			)}
		</section>
	);
}

/** One schema-driven metadata input, rendered by kind (handoff §5). */
function MetadataInput({
	field,
	awaiting,
	value,
	onChange,
}: {
	field: MetadataField;
	awaiting: boolean;
	value: string;
	onChange: (value: string) => void;
}) {
	const label = (
		<span className="text-xs text-muted-foreground">
			{field.label}
			{awaiting && (
				<span className="ml-1 text-amber-600">
					(awaiting — leave blank to defer)
				</span>
			)}
		</span>
	);

	if (field.kind === "boolean" || field.kind === "enum") {
		const options = field.kind === "boolean" ? ["yes", "no"] : field.options;
		return (
			<div>
				{label}
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
