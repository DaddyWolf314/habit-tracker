import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { amendEvent } from "#/lib/api.ts";
import { type AwaitedRuling, awaitedRulings } from "#/shared/adjudication.ts";
import type { EventType, MetadataField } from "#/shared/event-types.ts";
import type { EventView } from "#/shared/events.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { MetadataValue, Role } from "#/shared/roles.ts";
import { formatMetaValue, formatTime, memberLabel } from "./formatting.ts";

const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

/**
 * The adjudication queue, dom side (handoff §4.2, §9 surface 3). Every pending
 * event with a key this member is `adjudicated_by` for surfaces here waiting on
 * a ruling. Submitting a ruling is an `adjudication` amendment — it patches only
 * the awaited keys, and the engine re-evaluates the event so any rule that was
 * waiting on that key fires. Empty (and hidden) when nothing awaits a ruling.
 */
export function QueuePanel({
	events,
	types,
	members,
	selfRole,
	onAmended,
}: {
	events: EventView[];
	types: EventType[];
	members: RoleMember[];
	selfRole: Role | null;
	onAmended: () => void;
}) {
	const typeMap = new Map(types.map((t) => [t.id, t]));
	const queue = events.flatMap((event) => {
		const type = typeMap.get(event.type);
		if (!type) return [];
		const rulings = awaitedRulings(event, type, selfRole);
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
						rulings={rulings}
						members={members}
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
	rulings,
	members,
	onAmended,
}: {
	event: EventView;
	type: EventType;
	rulings: AwaitedRuling[];
	members: RoleMember[];
	onAmended: () => void;
}) {
	const [values, setValues] = useState<Record<string, string>>({});
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
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

	async function submit() {
		if (!ready) return;
		setBusy(true);
		setError(null);
		try {
			await amendEvent({
				kind: "adjudication",
				target_event_id: event.id,
				patch,
				note: note.trim() || undefined,
			});
			onAmended();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't record the ruling.",
			);
			setBusy(false);
		}
	}

	const context = Object.entries(event.composite_metadata);

	return (
		<li className="rounded-md border bg-background p-3">
			<div className="flex items-baseline justify-between gap-2">
				<span className="text-sm font-medium">{type.label}</span>
				<span className="text-xs text-muted-foreground">
					{formatTime(event.occurred_at)}
				</span>
			</div>
			<div className="text-xs text-muted-foreground">
				{memberLabel(event.actor, members)}
				{event.subject && <> · about {memberLabel(event.subject, members)}</>}
			</div>
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
					<span className="text-xs text-muted-foreground">Note (optional)</span>
					<Textarea
						className="mt-1"
						value={note}
						onChange={(e) => setNote(e.target.value)}
					/>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<Button onClick={submit} disabled={busy || !ready}>
					{busy ? "…" : "Record ruling"}
				</Button>
			</div>
		</li>
	);
}

/** One awaited-key control, rendered by field kind (mirrors the log composer). */
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
				<select
					className={`${fieldClass} mt-1`}
					value={value}
					onChange={(e) => onChange(e.target.value)}
				>
					<option value="">— decide —</option>
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
