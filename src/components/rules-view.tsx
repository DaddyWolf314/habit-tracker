import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
	createRule,
	deleteRule,
	getRoles,
	listCounters,
	listEventTypes,
	listRuleHistory,
	setRuleEnabled,
	updateRule,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { describeRule, isPickerEditable } from "#/shared/rule-describe.ts";
import type {
	Effect,
	Rule,
	RuleDefinition,
	RuleVersion,
	VersionedRule,
} from "#/shared/rules.ts";
import { DEFAULT_ANCHORS } from "#/templates/index.ts";

const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

/** The current (latest) version of a stored rule. */
function latestVersion(rule: VersionedRule): RuleVersion {
	return rule.versions.reduce((a, b) =>
		b.effective_from >= a.effective_from ? b : a,
	);
}

/** Flattens a stored rule's current version into the shape the formatter reads. */
function toFlat(rule: VersionedRule): Rule {
	const v = latestVersion(rule);
	return {
		id: rule.id,
		condition: v.condition,
		effects: v.effects,
		enabled: v.enabled,
	};
}

/**
 * The Rules screen (#64, ADR 0002). Every member can view the automation that
 * governs the dynamic — each rule in plain language, its enabled state, whether
 * it is a default-pack or custom rule (and whether an adopted pack rule has been
 * edited), and its revision history. A member holding dom authority (dom/switch)
 * also gets authoring controls; a sub sees the same rules read-only, never bound
 * by a rule they cannot inspect.
 */
export function RulesView() {
	const [ready, setReady] = useState(false);
	const [rules, setRules] = useState<VersionedRule[]>([]);
	const [types, setTypes] = useState<EventType[]>([]);
	const [counters, setCounters] = useState<Counter[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<VersionedRule | "new" | null>(null);

	const load = useCallback(async () => {
		try {
			const [ruleRes, typeRes, counterRes, roleRes] = await Promise.all([
				listRuleHistory(),
				listEventTypes(),
				listCounters(),
				getRoles(),
			]);
			setRules(ruleRes.rules);
			setTypes(typeRes.types);
			setCounters(counterRes.counters);
			setMembers(roleRes.members);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't load the rules.");
		}
	}, []);

	useEffect(() => {
		setReady(true);
		if (hasIdentity()) load();
	}, [load]);

	const typeMap = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
	const selfRole = members.find((m) => m.is_self)?.role ?? null;
	const canAuthor = selfRole === "dom" || selfRole === "switch";

	const afterChange = useCallback(() => {
		setEditing(null);
		load();
	}, [load]);

	if (!ready) return null;
	if (!hasIdentity()) {
		return (
			<div className="mx-auto max-w-2xl p-8">
				<p className="text-muted-foreground">
					You don't have a space on this device yet.{" "}
					<Link to="/" className="underline">
						Go back
					</Link>
					.
				</p>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-2xl space-y-4 p-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">Rules</h1>
				<Link to="/" className="text-sm underline">
					Back
				</Link>
			</div>

			<p className="text-sm text-muted-foreground">
				These are the automations that turn what you log into your counters and
				timers.{" "}
				{canAuthor
					? "You can add, edit, enable, or remove them."
					: "Only a dom or switch can change them — but you can always see them."}
			</p>

			{error && <p className="text-sm text-destructive">{error}</p>}

			{canAuthor && editing === null && (
				<Button onClick={() => setEditing("new")}>New rule</Button>
			)}

			{editing === "new" && (
				<RuleEditor
					existing={null}
					types={types}
					counters={counters}
					onSaved={afterChange}
					onCancel={() => setEditing(null)}
				/>
			)}

			<ul className="space-y-3">
				{rules.map((rule) => (
					<li key={rule.id}>
						{editing !== "new" && editing?.id === rule.id ? (
							<RuleEditor
								existing={rule}
								types={types}
								counters={counters}
								onSaved={afterChange}
								onCancel={() => setEditing(null)}
							/>
						) : (
							<RuleCard
								rule={rule}
								type={typeMap.get(latestVersion(rule).condition.type)}
								canAuthor={canAuthor}
								onEdit={() => setEditing(rule)}
								onChanged={load}
								onError={setError}
							/>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

/** One rule as a card: plain language, badges, revision history, and controls. */
function RuleCard({
	rule,
	type,
	canAuthor,
	onEdit,
	onChanged,
	onError,
}: {
	rule: VersionedRule;
	type: EventType | undefined;
	canAuthor: boolean;
	onEdit: () => void;
	onChanged: () => void;
	onError: (message: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const flat = toFlat(rule);
	const described = describeRule(flat, type);
	const editable = isPickerEditable(flat);

	const run = async (op: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await op();
			onChanged();
		} catch (err) {
			onError(err instanceof Error ? err.message : "That didn't work.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="rounded-lg border p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium">{described.when}</p>
					<ul className="mt-1 text-sm text-muted-foreground">
						{described.effects.map((phrase, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: phrases are positional
							<li key={i}>→ {phrase}</li>
						))}
					</ul>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					<Badge tone={rule.origin === "pack" ? "neutral" : "accent"}>
						{rule.origin === "pack" ? "default" : "custom"}
					</Badge>
					{rule.adopted && <Badge tone="accent">edited</Badge>}
					{!flat.enabled && <Badge tone="muted">off</Badge>}
				</div>
			</div>

			<div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
				<button
					type="button"
					className="underline text-muted-foreground"
					onClick={() => setShowHistory((s) => !s)}
				>
					{rule.versions.length} revision{rule.versions.length === 1 ? "" : "s"}
				</button>
				{canAuthor && (
					<>
						{editable ? (
							<Button
								size="xs"
								variant="outline"
								onClick={onEdit}
								disabled={busy}
							>
								Edit
							</Button>
						) : (
							<span className="text-muted-foreground">
								advanced — view only
							</span>
						)}
						<Button
							size="xs"
							variant="outline"
							disabled={busy}
							onClick={() => run(() => setRuleEnabled(rule.id, !flat.enabled))}
						>
							{flat.enabled ? "Disable" : "Enable"}
						</Button>
						<Button
							size="xs"
							variant="destructive"
							disabled={busy}
							onClick={() => run(() => deleteRule(rule.id))}
						>
							Remove
						</Button>
					</>
				)}
			</div>

			{showHistory && (
				<ol className="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground">
					{[...rule.versions]
						.sort((a, b) => a.effective_from - b.effective_from)
						.map((v) => (
							<li key={v.effective_from}>
								<span className="font-mono">
									{v.effective_from === 0
										? "installed"
										: new Date(v.effective_from).toLocaleString()}
								</span>
								{" — "}
								{v.enabled ? "" : "(off) "}
								{describeRule({ id: rule.id, ...v } as Rule, type).effects.join(
									", ",
								)}
							</li>
						))}
				</ol>
			)}
		</section>
	);
}

function Badge({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone: "neutral" | "accent" | "muted";
}) {
	const cls =
		tone === "accent"
			? "bg-primary/10 text-primary"
			: tone === "muted"
				? "bg-muted text-muted-foreground"
				: "bg-secondary text-secondary-foreground";
	return (
		<span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
			{children}
		</span>
	);
}

// ── The structured picker editor (#64) ──────────────────────────────────────

/** The effect verbs the picker offers — the everyday set; timer wiring is excluded. */
const EFFECT_VERBS = [
	{ verb: "increment_counter", label: "Add to a counter" },
	{ verb: "decrement_counter", label: "Subtract from a counter" },
	{ verb: "reset_counter", label: "Reset a counter" },
	{ verb: "reset_anchor", label: "Reset a clock" },
	{ verb: "notify", label: "Notify your partner" },
] as const;

type EffectVerb = (typeof EFFECT_VERBS)[number]["verb"];

interface EffectDraft {
	verb: EffectVerb;
	counter: string;
	anchor: string;
	by: string;
}

interface ConditionDraft {
	key: string;
	value: string;
}

/**
 * Create/edit editor. Offers only what actually exists — event types (minus the
 * internal `counter_*` sugar), the keys/values of the chosen type's metadata, and
 * the couple's known counters/anchors — so a rule that can never fire cannot be
 * authored. An edit appends a new version server-side (forward-only); a bad
 * condition or effect target surfaces the server's validation message inline.
 */
function RuleEditor({
	existing,
	types,
	counters,
	onSaved,
	onCancel,
}: {
	existing: VersionedRule | null;
	types: EventType[];
	counters: Counter[];
	onSaved: () => void;
	onCancel: () => void;
}) {
	const editableTypes = useMemo(
		() => types.filter((t) => !t.id.startsWith("counter_")),
		[types],
	);
	const seed = existing ? latestVersion(existing) : null;
	const [name, setName] = useState("");
	const [typeId, setTypeId] = useState(seed?.condition.type ?? "");
	const [conditions, setConditions] = useState<ConditionDraft[]>(
		seed
			? Object.entries(seed.condition.metadata).map(([key, value]) => ({
					key,
					value: String(value),
				}))
			: [],
	);
	const [effects, setEffects] = useState<EffectDraft[]>(
		seed ? seed.effects.map(effectToDraft) : [blankEffect()],
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const type = types.find((t) => t.id === typeId);
	const metaKeys = type ? Object.keys(type.metadata) : [];

	const build = (): { id: string; def: RuleDefinition } | null => {
		if (!type) {
			setError("Pick an event type first.");
			return null;
		}
		const metadata: Record<string, string | number | boolean> = {};
		for (const c of conditions) {
			if (!c.key) continue;
			const field = type.metadata[c.key];
			if (!field) continue;
			metadata[c.key] = coerceValue(field.kind, c.value);
		}
		const built: Effect[] = [];
		for (const e of effects) {
			const effect = draftToEffect(e);
			if (!effect) {
				setError("Every effect needs a target.");
				return null;
			}
			built.push(effect);
		}
		if (built.length === 0) {
			setError("Add at least one effect.");
			return null;
		}
		const def: RuleDefinition = {
			condition: { type: typeId, metadata },
			effects: built,
			enabled: seed?.enabled ?? true,
		};
		const id = existing ? existing.id : slugify(name);
		if (!id) {
			setError("Give the rule a short name.");
			return null;
		}
		return { id, def };
	};

	const save = async () => {
		setError(null);
		const result = build();
		if (!result) return;
		setBusy(true);
		try {
			if (existing) {
				await updateRule(existing.id, result.def);
			} else {
				await createRule({ id: result.id, ...result.def } as Rule);
			}
			onSaved();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't save the rule.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="rounded-lg border border-primary/40 p-4">
			<h2 className="text-lg font-semibold">
				{existing ? `Edit ${existing.id}` : "New rule"}
			</h2>

			{!existing && (
				<div className="mt-3">
					<span className="text-xs text-muted-foreground">Short name</span>
					<input
						className={`${fieldClass} mt-1`}
						value={name}
						placeholder="e.g. late check-in demerit"
						onChange={(e) => setName(e.target.value)}
					/>
				</div>
			)}

			<div className="mt-3">
				<span className="text-xs text-muted-foreground">When this happens</span>
				<select
					className={`${fieldClass} mt-1`}
					value={typeId}
					onChange={(e) => {
						setTypeId(e.target.value);
						setConditions([]);
					}}
				>
					<option value="">Choose an event…</option>
					{editableTypes.map((t) => (
						<option key={t.id} value={t.id}>
							{t.label}
						</option>
					))}
				</select>
			</div>

			{type && (
				<div className="mt-3 space-y-2">
					<span className="text-xs text-muted-foreground">
						Only when… (optional conditions)
					</span>
					{conditions.map((cond, i) => {
						const field = cond.key ? type.metadata[cond.key] : undefined;
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: draft rows are positional
							<div key={i} className="flex items-center gap-2">
								<select
									className={fieldClass}
									value={cond.key}
									onChange={(e) =>
										setConditions((cs) =>
											cs.map((c, j) =>
												j === i ? { key: e.target.value, value: "" } : c,
											),
										)
									}
								>
									<option value="">key…</option>
									{metaKeys.map((k) => (
										<option key={k} value={k}>
											{type.metadata[k]?.label ?? k}
										</option>
									))}
								</select>
								<span className="text-muted-foreground">is</span>
								<ConditionValue
									field={field}
									value={cond.value}
									onChange={(v) =>
										setConditions((cs) =>
											cs.map((c, j) => (j === i ? { ...c, value: v } : c)),
										)
									}
								/>
								<Button
									size="xs"
									variant="ghost"
									onClick={() =>
										setConditions((cs) => cs.filter((_, j) => j !== i))
									}
								>
									×
								</Button>
							</div>
						);
					})}
					{metaKeys.length > 0 && (
						<Button
							size="xs"
							variant="outline"
							onClick={() =>
								setConditions((cs) => [...cs, { key: "", value: "" }])
							}
						>
							Add condition
						</Button>
					)}
				</div>
			)}

			<div className="mt-4 space-y-2">
				<span className="text-xs text-muted-foreground">Then do this</span>
				{effects.map((eff, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: draft rows are positional
					<div key={i} className="flex flex-wrap items-center gap-2">
						<select
							className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
							value={eff.verb}
							onChange={(e) =>
								setEffects((es) =>
									es.map((x, j) =>
										j === i ? { ...x, verb: e.target.value as EffectVerb } : x,
									),
								)
							}
						>
							{EFFECT_VERBS.map((v) => (
								<option key={v.verb} value={v.verb}>
									{v.label}
								</option>
							))}
						</select>
						<EffectTarget
							draft={eff}
							counters={counters}
							onChange={(patch) =>
								setEffects((es) =>
									es.map((x, j) => (j === i ? { ...x, ...patch } : x)),
								)
							}
						/>
						{effects.length > 1 && (
							<Button
								size="xs"
								variant="ghost"
								onClick={() => setEffects((es) => es.filter((_, j) => j !== i))}
							>
								×
							</Button>
						)}
					</div>
				))}
				<Button
					size="xs"
					variant="outline"
					onClick={() => setEffects((es) => [...es, blankEffect()])}
				>
					Add effect
				</Button>
			</div>

			{error && <p className="mt-3 text-sm text-destructive">{error}</p>}

			<div className="mt-4 flex gap-2">
				<Button onClick={save} disabled={busy}>
					{busy ? "…" : existing ? "Save changes" : "Create rule"}
				</Button>
				<Button variant="ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
			</div>
		</section>
	);
}

/** The value input for a condition, driven by the chosen field's kind. */
function ConditionValue({
	field,
	value,
	onChange,
}: {
	field: EventType["metadata"][string] | undefined;
	value: string;
	onChange: (value: string) => void;
}) {
	if (field?.kind === "boolean") {
		return (
			<select
				className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				<option value="">—</option>
				<option value="yes">yes</option>
				<option value="no">no</option>
			</select>
		);
	}
	if (field?.kind === "enum") {
		return (
			<select
				className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				<option value="">—</option>
				{field.options.map((o) => (
					<option key={o} value={o}>
						{o}
					</option>
				))}
			</select>
		);
	}
	return (
		<input
			className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
			type={field?.kind === "number" ? "number" : "text"}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
}

/** The target picker for an effect: a counter, an anchor, an amount, or nothing. */
function EffectTarget({
	draft,
	counters,
	onChange,
}: {
	draft: EffectDraft;
	counters: Counter[];
	onChange: (patch: Partial<EffectDraft>) => void;
}) {
	if (draft.verb === "notify") return null;
	if (draft.verb === "reset_anchor") {
		return (
			<select
				className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
				value={draft.anchor}
				onChange={(e) => onChange({ anchor: e.target.value })}
			>
				<option value="">clock…</option>
				{DEFAULT_ANCHORS.map((a) => (
					<option key={a} value={a}>
						{a.replace(/_/g, " ")}
					</option>
				))}
			</select>
		);
	}
	const showBy =
		draft.verb === "increment_counter" || draft.verb === "decrement_counter";
	return (
		<>
			<select
				className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
				value={draft.counter}
				onChange={(e) => onChange({ counter: e.target.value })}
			>
				<option value="">counter…</option>
				{counters.map((c) => (
					<option key={c.id} value={c.id}>
						{c.name}
					</option>
				))}
			</select>
			{showBy && (
				<input
					className="w-16 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
					type="number"
					min={1}
					value={draft.by}
					onChange={(e) => onChange({ by: e.target.value })}
				/>
			)}
		</>
	);
}

// ── draft <-> effect conversion ─────────────────────────────────────────────

function blankEffect(): EffectDraft {
	return { verb: "increment_counter", counter: "", anchor: "", by: "1" };
}

function effectToDraft(effect: Effect): EffectDraft {
	const base = blankEffect();
	switch (effect.verb) {
		case "increment_counter":
		case "decrement_counter":
			return {
				...base,
				verb: effect.verb,
				counter: effect.counter,
				by: String(effect.by),
			};
		case "reset_counter":
			return { ...base, verb: "reset_counter", counter: effect.counter };
		case "reset_anchor":
			return { ...base, verb: "reset_anchor", anchor: effect.anchor };
		case "notify":
			return { ...base, verb: "notify" };
		default:
			// Timer effects aren't picker-editable; such rules never reach the editor.
			return base;
	}
}

function draftToEffect(draft: EffectDraft): Effect | null {
	switch (draft.verb) {
		case "increment_counter":
		case "decrement_counter":
			if (!draft.counter) return null;
			return {
				verb: draft.verb,
				counter: draft.counter,
				by: Math.max(1, Math.trunc(Number(draft.by) || 1)),
			};
		case "reset_counter":
			return draft.counter
				? { verb: "reset_counter", counter: draft.counter }
				: null;
		case "reset_anchor":
			return draft.anchor
				? { verb: "reset_anchor", anchor: draft.anchor }
				: null;
		case "notify":
			return { verb: "notify", target: "partner" };
	}
}

function coerceValue(
	kind: EventType["metadata"][string]["kind"],
	raw: string,
): string | number | boolean {
	if (kind === "boolean") return raw === "yes";
	if (kind === "number") return Number(raw);
	return raw;
}

/** A short name → a stable custom id; never the reserved `R#` pack namespace. */
function slugify(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return base ? `custom-${base}` : "";
}
