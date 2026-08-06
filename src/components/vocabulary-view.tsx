import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
	addEventTypeOption,
	getRoles,
	listEventTypeOptions,
	listEventTypes,
	renameEventTypeOption,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import type {
	EventType,
	MetadataField,
	OptionAddition,
} from "#/shared/event-types.ts";
import {
	optionLabel,
	optionTokenSchema,
	toOptionToken,
} from "#/shared/event-types.ts";
import type { Role } from "#/shared/roles.ts";
import { rolePermits } from "#/shared/roles.ts";

/**
 * The vocabulary screen (#185, ADR 0014) — the couple's own words for what they
 * already log.
 *
 * A **small surface on purpose**. What you edit here is one list of strings, not
 * a schema: there is no field-kind picker, no permission list, no `awaiting`
 * editor, and no way to author or retire a type. Adding a word to `act` is a
 * thing a couple wants monthly; authoring an event type is a thing they want
 * approximately never, and building the second to deliver the first is how a
 * screen ends up with a five-way discriminated union on it.
 *
 * Two rules the UI has to make legible, because both are invisible in the data:
 *
 *  - **A word has a stored token and a read label.** The token is what an event,
 *    a rule condition and an export carry, so it never moves once written; the
 *    label is what everyone reads and can be changed freely. The add form shows
 *    the token it is about to mint, so nobody is surprised by it later.
 *  - **The pack's words are not yours to rename.** They arrive from the shipped
 *    pack and a bump keeps improving them; renaming one here would fork copy that
 *    is still being maintained upstream. Only your own are editable, which is why
 *    the screen asks the server which are yours rather than guessing from the
 *    merged type — the merge deliberately makes them indistinguishable.
 */
export function VocabularyView() {
	const [ready, setReady] = useState(false);
	const [types, setTypes] = useState<EventType[]>([]);
	// Provenance, from its own endpoint: which of the merged options are ours.
	const [mine, setMine] = useState<OptionAddition[]>([]);
	const [selfRole, setSelfRole] = useState<Role | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const [typeRes, optionRes, roleRes] = await Promise.all([
			listEventTypes(),
			listEventTypeOptions(),
			getRoles(),
		]);
		setTypes(typeRes.types);
		setMine(optionRes.options);
		setSelfRole(
			(roleRes.members.find((m) => m.is_self)?.role ?? null) as Role | null,
		);
	}, []);

	const reload = useCallback(async () => {
		try {
			await load();
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't load your words.",
			);
		}
	}, [load]);

	useEffect(() => {
		setReady(true);
		if (!hasIdentity()) return;
		void reload();
	}, [reload]);

	/**
	 * Every enum this member may extend, gated on the field's own
	 * `set_permission` — the same list the server checks, through the same helper,
	 * so the screen can never offer a control whose write is refused. A field you
	 * may not set is simply absent rather than shown disabled: it is not a thing
	 * you are being denied, it is not yours to say.
	 */
	const editable = useMemo(() => {
		const rows: { type: EventType; key: string; field: EnumField }[] = [];
		for (const type of types) {
			for (const [key, field] of Object.entries(type.metadata)) {
				if (field.kind !== "enum") continue;
				if (!rolePermits(selfRole, field.set_permission)) continue;
				rows.push({ type, key, field });
			}
		}
		return rows;
	}, [types, selfRole]);

	if (!ready) return null;
	if (!hasIdentity()) {
		return (
			<div className="mx-auto max-w-2xl p-8">
				<p className="text-muted-foreground">
					You don't have a space on this device yet.
				</p>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-2xl space-y-6 p-6">
			<div>
				<h1 className="text-2xl font-bold">Your words</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					The app ships a starting vocabulary. Add your own words to any of
					these lists and they'll show up wherever you log — and in rules you
					write about them.
				</p>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			{editable.length === 0 && !error && (
				<p className="text-sm text-muted-foreground">
					There's nothing here you can add to yet.
				</p>
			)}

			{editable.map(({ type, key, field }) => (
				<OptionList
					key={`${type.id}.${key}`}
					typeId={type.id}
					typeLabel={type.label}
					fieldKey={key}
					field={field}
					mine={
						new Set(
							mine
								.filter((o) => o.type_id === type.id && o.field_key === key)
								.map((o) => o.option),
						)
					}
					onChanged={reload}
				/>
			))}
		</div>
	);
}

type EnumField = Extract<MetadataField, { kind: "enum" }>;

/** One enum: the words in it, and the form that adds another. */
function OptionList({
	typeId,
	typeLabel,
	fieldKey,
	field,
	mine,
	onChanged,
}: {
	typeId: string;
	typeLabel: string;
	fieldKey: string;
	field: EnumField;
	mine: Set<string>;
	onChanged: () => Promise<void>;
}) {
	const addId = useId();
	const [word, setWord] = useState("");
	const [renaming, setRenaming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const token = toOptionToken(word);
	const tokenValid = optionTokenSchema.safeParse(token).success;
	const duplicate = field.options.includes(token);

	async function submit(run: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		try {
			await run();
			await onChanged();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't save that.");
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function handleAdd() {
		const ok = await submit(() =>
			addEventTypeOption({
				type_id: typeId,
				field_key: fieldKey,
				option: token,
				label: word.trim(),
			}),
		);
		if (ok) setWord("");
	}

	return (
		<section className="rounded-md border p-4">
			<h2 className="font-medium">{field.label}</h2>
			<p className="mt-1 text-sm text-muted-foreground">
				on {typeLabel.toLowerCase()}
			</p>

			<ul className="mt-3 space-y-1">
				{field.options.map((option) =>
					renaming === option ? (
						<li key={option}>
							<RenameRow
								option={option}
								current={optionLabel(field, option)}
								busy={busy}
								onSave={async (label) => {
									const ok = await submit(() =>
										renameEventTypeOption({
											type_id: typeId,
											field_key: fieldKey,
											option,
											label,
										}),
									);
									if (ok) setRenaming(null);
								}}
								onCancel={() => setRenaming(null)}
							/>
						</li>
					) : (
						<li key={option} className="flex items-center gap-2 text-sm">
							<span>{optionLabel(field, option)}</span>
							{mine.has(option) && <Badge tone="accent">yours</Badge>}
							{mine.has(option) && (
								<Button
									variant="ghost"
									size="xs"
									onClick={() => setRenaming(option)}
								>
									Rename
								</Button>
							)}
						</li>
					),
				)}
			</ul>

			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<label htmlFor={addId} className="sr-only">
					A word to add to {field.label}
				</label>
				<Input
					id={addId}
					value={word}
					placeholder="Add a word"
					className="max-w-[16rem] flex-1"
					onChange={(e) => setWord(e.target.value)}
				/>
				<Button
					size="sm"
					disabled={busy || !tokenValid || duplicate}
					onClick={handleAdd}
				>
					Add
				</Button>
			</div>
			{/* The token is shown before it is minted, not after. It is what the log
			    and every rule you write will carry, and it never changes again — the
			    one part of this screen a person cannot undo by typing over it. */}
			{token !== "" && (
				<p className="mt-2 text-xs text-muted-foreground">
					{duplicate
						? `"${token}" is already on this list.`
						: `Saved as ${token}.`}
				</p>
			)}
		</section>
	);
}

/** Renaming changes what a word reads as. The stored token stays put. */
function RenameRow({
	option,
	current,
	busy,
	onSave,
	onCancel,
}: {
	option: string;
	current: string;
	busy: boolean;
	onSave: (label: string) => Promise<void>;
	onCancel: () => void;
}) {
	const inputId = useId();
	const [label, setLabel] = useState(current);

	return (
		<div className="flex flex-wrap items-center gap-2">
			<label htmlFor={inputId} className="sr-only">
				What {option} reads as
			</label>
			<Input
				id={inputId}
				value={label}
				className="max-w-[16rem] flex-1"
				onChange={(e) => setLabel(e.target.value)}
			/>
			<Button
				size="sm"
				disabled={busy || label.trim() === ""}
				onClick={() => onSave(label.trim())}
			>
				Save
			</Button>
			<Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
				Cancel
			</Button>
			<span className="text-xs text-muted-foreground">
				still logged as {option}
			</span>
		</div>
	);
}
