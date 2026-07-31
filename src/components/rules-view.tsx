import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { fieldClass } from "#/components/ui/field.ts";
import {
	createRule,
	deleteRule,
	getRoles,
	listAgreements,
	listCounters,
	listEventTypes,
	listRuleHistory,
	renameRule,
	setRuleEnabled,
	updateRule,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import {
	agreementEffectiveAt,
	agreementsInForce,
	type VersionedAgreement,
} from "#/shared/agreements.ts";
import type { Counter } from "#/shared/counters.ts";
import { type EventType, optionLabel } from "#/shared/event-types.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { isCitingRef, isOriginatingRef } from "#/shared/refs.ts";
import type { Role } from "#/shared/roles.ts";
import {
	COMPARISON_COPY,
	describeCondition,
	describeRule,
	isPickerEditable,
} from "#/shared/rule-describe.ts";
import {
	type ComparisonClause,
	currentRule,
	type Effect,
	isComparisonClause,
	latestVersion,
	type Rule,
	type RuleCondition,
	type RuleDefinition,
	ruleFromVersion,
	ruleName,
	type VersionedRule,
} from "#/shared/rules.ts";
import { humanize } from "#/shared/trace.ts";
import {
	anchorLabel,
	DEFAULT_ANCHORS,
	DEFAULT_TIMERS,
} from "#/templates/index.ts";

/**
 * The Rules screen (#64, ADR 0002), reached from Settings since #123. Every
 * member can view the automation that governs the dynamic — each rule in plain
 * language, its enabled state, whether
 * it is a default-pack or custom rule (and whether an adopted pack rule has been
 * edited), and its revision history. A member holding dom authority (dom/switch)
 * also gets authoring controls; a sub sees the same rules read-only, never bound
 * by a rule they cannot inspect. What the partner *changed* is not shown here —
 * {@link RuleChangeNotice} carries that to Today, because ADR 0002 leans on it
 * as the consent substitute for dom-only authoring and it cannot do that job
 * from a screen the bound party has no daily reason to open.
 */
export function RulesView() {
	const [ready, setReady] = useState(false);
	const [rules, setRules] = useState<VersionedRule[]>([]);
	const [types, setTypes] = useState<EventType[]>([]);
	const [counters, setCounters] = useState<Counter[]>([]);
	const [agreements, setAgreements] = useState<VersionedAgreement[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<VersionedRule | "new" | null>(null);

	const load = useCallback(async () => {
		try {
			const [ruleRes, typeRes, counterRes, roleRes, agreementRes] =
				await Promise.all([
					listRuleHistory(),
					listEventTypes(),
					listCounters(),
					getRoles(),
					listAgreements(),
				]);
			setRules(ruleRes.rules);
			setTypes(typeRes.types);
			setCounters(counterRes.counters);
			setMembers(roleRes.members);
			setAgreements(agreementRes.agreements);
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
			<h1 className="text-2xl font-bold">Rules</h1>

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
					agreements={agreements}
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
								agreements={agreements}
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
	// Per-rule: every rule renders one of these, so `aria-controls` has to name
	// this rule's revision list rather than some other rule's (#148).
	const historyId = useId();
	// Removing a rule is irreversible and has no undo surface, so it takes the
	// house two-tap inline confirm (dissolve, retraction, counter delete) rather
	// than a browser dialog, which would block the whole surface.
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	// A rule the picker won't edit can still be renamed (#150) — an inline box on
	// the card rather than the full editor, which has no way to render the timer
	// wiring that put the rule out of its reach in the first place.
	const [renaming, setRenaming] = useState(false);
	const flat = currentRule(rule);
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
					{/* The name the couple gave it (#150), over the plain-language
					    reading of what it actually does — the two answer different
					    questions, and the name alone can drift from the behaviour. */}
					<p className="font-medium">{ruleName(flat)}</p>
					<p className="mt-0.5 text-sm">{described.when}</p>
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
					{rule.upstream_changed && <Badge tone="accent">new default</Badge>}
					{!flat.enabled && <Badge tone="muted">off</Badge>}
				</div>
			</div>

			<div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
				<button
					type="button"
					className="underline text-muted-foreground"
					aria-expanded={showHistory}
					aria-controls={historyId}
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
							<>
								{/* Still view-only for what it *does* — the picker cannot
								    represent timer wiring (#64). What it is *called* is a
								    different axis, and leaving it unrenameable would have left
								    exactly the ids #150 was filed about on the timer rules. */}
								<span className="text-muted-foreground">
									advanced — effects view only
								</span>
								<Button
									size="xs"
									variant="outline"
									disabled={busy || renaming}
									onClick={() => setRenaming(true)}
								>
									Rename
								</Button>
							</>
						)}
						<Button
							size="xs"
							variant="outline"
							disabled={busy}
							onClick={() => run(() => setRuleEnabled(rule.id, !flat.enabled))}
						>
							{flat.enabled ? "Disable" : "Enable"}
						</Button>
						{confirmingRemove ? (
							<InlineConfirm
								label="Yes, remove"
								size="xs"
								busy={busy}
								onConfirm={() =>
									run(async () => {
										await deleteRule(rule.id);
										// A custom rule that never fired is purged, but a pack
										// rule or one that has fired collapses to a disable and
										// stays in the list (ADR 0002) — this card lives on, so
										// it has to disarm itself.
										setConfirmingRemove(false);
									})
								}
								onCancel={() => setConfirmingRemove(false)}
							/>
						) : (
							<Button
								size="xs"
								variant="outline"
								className="text-destructive"
								disabled={busy}
								onClick={() => setConfirmingRemove(true)}
							>
								Remove
							</Button>
						)}
					</>
				)}
			</div>

			{renaming && (
				<RuleRenameForm
					rule={flat}
					busy={busy}
					onSubmit={(name) =>
						run(async () => {
							await renameRule(rule.id, name);
							setRenaming(false);
						})
					}
					onCancel={() => setRenaming(false)}
				/>
			)}

			{showHistory && (
				<ol
					id={historyId}
					className="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground"
				>
					{[...rule.versions]
						.sort((a, b) => a.effective_from - b.effective_from)
						.map((v) => {
							// The full description per version — condition and effects — so a
							// condition-only edit is visible in the history (#64, story 8).
							const flatVersion = ruleFromVersion(rule.id, v);
							const d = describeRule(flatVersion, type);
							return (
								<li key={v.effective_from}>
									<span className="font-mono">
										{v.effective_from === 0
											? "installed"
											: new Date(v.effective_from).toLocaleString()}
									</span>
									{" — "}
									{/* Each row says what the rule was called *then* (#150,
									    ADR 0009). Rendering today's name here would quietly
									    rewrite the history this list exists to show. */}
									<span className="font-medium">{ruleName(flatVersion)}</span>
									{": "}
									{v.enabled ? "" : "(off) "}
									{d.when} → {d.effects.join(", ")}
								</li>
							);
						})}
				</ol>
			)}
		</section>
	);
}

/**
 * The name-only editor for a rule the picker won't touch (#150).
 *
 * Deliberately not the full {@link RuleEditor} with its other fields hidden: that
 * editor builds a whole definition from its drafts, and a rule it cannot
 * represent would come out the other side with its timer effects flattened into
 * nothing. This submits a name and only a name, against a server op that reads
 * the definition from storage rather than accepting one from here.
 */
function RuleRenameForm({
	rule,
	busy,
	onSubmit,
	onCancel,
}: {
	rule: Rule;
	busy: boolean;
	onSubmit: (name: string) => void;
	onCancel: () => void;
}) {
	const fieldId = useId();
	// Seeded through the same fallback the heading uses, so a rule that has never
	// been named opens with its de-slug to correct rather than a blank box.
	const [draft, setDraft] = useState(() => ruleName(rule));
	const trimmed = draft.trim();

	return (
		<form
			className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (trimmed) onSubmit(trimmed);
			}}
		>
			<div className="min-w-0 flex-1">
				<label htmlFor={fieldId} className="text-xs text-muted-foreground">
					Name
				</label>
				<input
					id={fieldId}
					className={`${fieldClass} mt-1`}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
				/>
			</div>
			<Button size="sm" type="submit" disabled={busy || !trimmed}>
				{busy ? "…" : "Save name"}
			</Button>
			<Button size="sm" type="button" variant="ghost" onClick={onCancel}>
				Cancel
			</Button>
		</form>
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
	/** `eq` is the equality every non-number field is limited to (ADR 0011). */
	op: "eq" | ComparisonClause["op"];
}

/** One ambient-state clause being authored (ADR 0011). */
interface TimerDraft {
	timer: string;
	/** Whether the rule wants the timer running, or wants it *not* running. */
	wanted: boolean;
}

/**
 * The operators offered beside a number field: plain equality, then each
 * comparison in `rule-describe`'s own words (ADR 0011). Read from
 * {@link COMPARISON_COPY} rather than restated, so the row the author builds and
 * the preview sentence under it cannot drift into two vocabularies — they render
 * different grammars of the same phrase ("is at most" + "2" against "2 or less"),
 * which is exactly the pair that drifts unnoticed when it is written twice.
 */
const COMPARISON_OPS: { op: ConditionDraft["op"]; label: string }[] = [
	{ op: "eq", label: "is" },
	...(Object.keys(COMPARISON_COPY) as ComparisonClause["op"][]).map((op) => ({
		op,
		label: COMPARISON_COPY[op].operator,
	})),
];

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
	agreements,
	onSaved,
	onCancel,
}: {
	existing: VersionedRule | null;
	types: EventType[];
	counters: Counter[];
	/** The corpus a citing-ref condition picks from (#121, ADR 0006). */
	agreements: VersionedAgreement[];
	onSaved: () => void;
	onCancel: () => void;
}) {
	const editableTypes = useMemo(
		() => types.filter((t) => !t.id.startsWith("counter_")),
		[types],
	);
	const seed = existing ? latestVersion(existing) : null;
	// Prefix for this editor's field ids, so the labels below can name their
	// controls explicitly (#148).
	const ids = useId();
	// Seeded through the fallback (#150), so a rule that predates naming — or a
	// pack rule seeded before v11 — opens with the de-slug already in the box,
	// which the author corrects rather than invents from a blank.
	const [name, setName] = useState(
		existing ? ruleName(currentRule(existing)) : "",
	);
	const [typeId, setTypeId] = useState(seed?.condition.type ?? "");
	// Subject-role qualifier (ADR 0003): "" means unqualified — the rule matches
	// regardless of who the event is about. Kept across type changes (the clause
	// is type-independent; every event may carry a subject).
	const [subjectRole, setSubjectRole] = useState<Role | "">(
		seed?.condition.subject_role ?? "",
	);
	const [conditions, setConditions] = useState<ConditionDraft[]>(
		seed
			? Object.entries(seed.condition.metadata).map(([key, value]) =>
					isComparisonClause(value)
						? { key, value: String(value.value), op: value.op }
						: { key, value: String(value), op: "eq" as const },
				)
			: [],
	);
	// Ambient-state clauses (ADR 0011). Separate from `conditions` because they
	// constrain the moment rather than the event — the same split the preview
	// sentence makes ("… , while a denial period is running").
	const [timerClauses, setTimerClauses] = useState<TimerDraft[]>(
		Object.entries(seed?.condition.timer_active ?? {}).map(
			([timer, wanted]) => ({ timer, wanted }),
		),
	);
	const [effects, setEffects] = useState<EffectDraft[]>(
		seed ? seed.effects.map(effectToDraft) : [blankEffect()],
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Two-stage save (#77, mirroring the queue's ruling flow): "Review rule"
	// builds and snapshots the draft, the confirm sheet renders that snapshot
	// through the shared phrasing, and only "Confirm" commits it.
	const [stage, setStage] = useState<"edit" | "confirm">("edit");
	const [confirmed, setConfirmed] = useState<{
		id: string;
		def: RuleDefinition;
	} | null>(null);

	const type = types.find((t) => t.id === typeId);
	// Conditions are authored against values a person can know in advance, so an
	// originating ref is not offerable: it is a ULID the server mints at log time
	// (ADR 0005), and an equality condition on one could only ever match the single
	// event that minted it. Offering it would also list two "Task" keys on
	// `task_assigned` — the minted id and the name beside it — where only the name
	// is a real choice.
	const metaKeys = type
		? Object.entries(type.metadata)
				.filter(([, field]) => !isOriginatingRef(field))
				.map(([key]) => key)
		: [];

	// Live preview through the one shared phrasing path (rule-describe), so what
	// the author reads here is exactly what the rules screen and the trace chain
	// will say — including the subject clause ("… about the dom", ADR 0003) and
	// the ambient one ("… , while a denial period is running", ADR 0011).
	const previewWhen = useMemo(
		() =>
			type
				? describeCondition(
						draftCondition(type, subjectRole, conditions, timerClauses),
						type,
					)
				: null,
		[type, subjectRole, conditions, timerClauses],
	);

	const build = (): { id: string; def: RuleDefinition } | null => {
		// First failure wins, and these are checked in the order the fields are read
		// down the form — a blank name is reported before "pick an event type", or
		// the author is sent back to a control they already filled in.
		const trimmed = name.trim();
		if (!trimmed) {
			setError("Give the rule a name.");
			return null;
		}
		if (!type) {
			setError("Pick an event type first.");
			return null;
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
			name: trimmed,
			// The same builder the live preview reads, so what gets saved is exactly
			// the sentence the author was shown.
			condition: draftCondition(type, subjectRole, conditions, timerClauses),
			effects: built,
			enabled: seed?.enabled ?? true,
		};
		// Only a create derives the id from the name. A rename appends a version
		// carrying the new name (ADR 0009) and leaves the id alone — ids are stable
		// by design, and re-slugging one would orphan every trace row citing it.
		const id = existing ? existing.id : slugify(trimmed);
		if (!id) {
			setError("That name has no letters or numbers to build an id from.");
			return null;
		}
		return { id, def };
	};

	const review = () => {
		setError(null);
		const result = build();
		if (!result) return;
		setConfirmed(result);
		setStage("confirm");
	};

	const save = async () => {
		if (!confirmed) return;
		setError(null);
		setBusy(true);
		try {
			if (existing) {
				await updateRule(existing.id, confirmed.def);
			} else {
				await createRule({ id: confirmed.id, ...confirmed.def });
			}
			onSaved();
		} catch (err) {
			// Server validation keeps its inline surface — the sheet stays up with
			// the message, and "Back" returns to the pickers to fix the draft.
			setError(err instanceof Error ? err.message : "Couldn't save the rule.");
		} finally {
			setBusy(false);
		}
	};

	// The confirm sheet (#77): the snapshotted draft through the one shared
	// phrasing path (describeRule), so "what will fire" reads identically to the
	// rules screen and the trace's "what fired" — subject clause included.
	if (stage === "confirm" && confirmed) {
		const draft = { id: confirmed.id, ...confirmed.def };
		const described = describeRule(draft, type);
		return (
			<section className="rounded-lg border border-primary/40 p-4">
				{/* The *drafted* name, not the stored one: this sheet describes what is
				    about to be committed, and a rename is part of it (#150). */}
				<h2 className="text-lg font-semibold">
					{existing ? `Edit ${ruleName(draft)}` : "New rule"}
				</h2>
				<div className="mt-3 space-y-3 rounded-md border bg-muted/40 p-3">
					<p className="text-xs font-medium text-muted-foreground">
						This rule will read:
					</p>
					<p className="text-sm font-medium">{described.when}</p>
					<ul className="space-y-1 text-sm text-muted-foreground">
						{described.effects.map((phrase, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: phrases are positional
							<li key={i}>→ {phrase}</li>
						))}
					</ul>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex gap-2">
						<Button onClick={save} disabled={busy}>
							{busy ? "…" : existing ? "Save changes" : "Create rule"}
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
			</section>
		);
	}

	return (
		<section className="rounded-lg border border-primary/40 p-4">
			{/* The heading reads the *stored* name (#150) — "Edit custom-late-check-in"
			    was the symptom the issue was filed about. The draft name lives in the
			    field below, so a heading tracking it would rewrite itself mid-typing. */}
			<h2 className="text-lg font-semibold">
				{existing ? `Edit ${ruleName(currentRule(existing))}` : "New rule"}
			</h2>

			{/* Shown on an edit as well as a create: renaming is the point of #150, and
			    it appends a version like any other change, so past history rows and
			    change notices keep saying what the rule was called then (ADR 0009). */}
			<div className="mt-3">
				<label
					htmlFor={`${ids}-name`}
					className="text-xs text-muted-foreground"
				>
					Name
				</label>
				<input
					id={`${ids}-name`}
					className={`${fieldClass} mt-1`}
					value={name}
					placeholder="e.g. late check-in demerit"
					onChange={(e) => setName(e.target.value)}
				/>
				{!existing && (
					<p className="mt-1 text-xs text-muted-foreground">
						This also sets the rule's id, which never changes — the name can be
						edited later.
					</p>
				)}
			</div>

			<div className="mt-3">
				<label
					htmlFor={`${ids}-type`}
					className="text-xs text-muted-foreground"
				>
					When this happens
				</label>
				<select
					id={`${ids}-type`}
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
				<div className="mt-3">
					<label
						htmlFor={`${ids}-subject-role`}
						className="text-xs text-muted-foreground"
					>
						About… (optional — whose event this rule watches)
					</label>
					<select
						id={`${ids}-subject-role`}
						className={`${fieldClass} mt-1`}
						value={subjectRole}
						// The options below are exactly the Role enum plus "" — the only
						// values the picker can produce.
						onChange={(e) => setSubjectRole(e.target.value as Role | "")}
					>
						<option value="">anyone</option>
						<option value="dom">the dom</option>
						<option value="sub">the sub</option>
						<option value="switch">a switch</option>
					</select>
				</div>
			)}

			{/* A fieldset, because the caption is over repeating rows rather than one
			    control (#148): the legend names the group, and each row's own controls
			    carry their own names below — a visible per-row label would re-flow a
			    deliberately dense row. */}
			{type && (
				<fieldset className="mt-3 space-y-2">
					<legend className="text-xs text-muted-foreground">
						Only when… (optional conditions)
					</legend>
					{conditions.map((cond, i) => {
						const field = cond.key ? type.metadata[cond.key] : undefined;
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: draft rows are positional
							<div key={i} className="flex items-center gap-2">
								<select
									aria-label={`Condition ${i + 1} key`}
									className={fieldClass}
									value={cond.key}
									onChange={(e) =>
										setConditions((cs) =>
											cs.map((c, j) =>
												// Changing the key resets the operator too: a comparison
												// carried onto an enum is one the server would refuse.
												j === i
													? { key: e.target.value, value: "", op: "eq" }
													: c,
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
								{/* Only a number can be compared (ADR 0011), so every other
								    field keeps the plain word it always had rather than a
								    one-option select. */}
								{field?.kind === "number" ? (
									<select
										aria-label={`Condition ${i + 1} comparison`}
										className={fieldClass}
										value={cond.op}
										onChange={(e) =>
											setConditions((cs) =>
												cs.map((c, j) =>
													j === i
														? {
																...c,
																op: e.target.value as ConditionDraft["op"],
															}
														: c,
												),
											)
										}
									>
										{COMPARISON_OPS.map((o) => (
											<option key={o.op} value={o.op}>
												{o.label}
											</option>
										))}
									</select>
								) : (
									<span className="text-muted-foreground">is</span>
								)}
								<ConditionValue
									label={`Condition ${i + 1} value`}
									field={field}
									value={cond.value}
									agreements={agreements}
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
								setConditions((cs) => [...cs, { key: "", value: "", op: "eq" }])
							}
						>
							Add condition
						</Button>
					)}
				</fieldset>
			)}

			{/* The ambient-state predicate (ADR 0011), in its own group because it
			    constrains the moment rather than the event — the same split the
			    preview sentence makes. Shown only once a type is picked, like the
			    conditions above, so the form reveals itself in one order. */}
			{type && (
				<fieldset className="mt-3 space-y-2">
					<legend className="text-xs text-muted-foreground">
						Only while… (optional timers)
					</legend>
					{timerClauses.map((clause, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: draft rows are positional
						<div key={i} className="flex items-center gap-2">
							<select
								aria-label={`Timer ${i + 1}`}
								className={fieldClass}
								value={clause.timer}
								onChange={(e) =>
									setTimerClauses((cs) =>
										cs.map((c, j) =>
											j === i ? { ...c, timer: e.target.value } : c,
										),
									)
								}
							>
								<option value="">timer…</option>
								{DEFAULT_TIMERS.map((t) => (
									<option key={t} value={t}>
										{/* The same de-slug the preview sentence renders, so the
										    picked option and "while a denial period is running"
										    are visibly the same thing. */}
										{humanize(t)}
									</option>
								))}
							</select>
							<select
								aria-label={`Timer ${i + 1} state`}
								className={fieldClass}
								value={clause.wanted ? "running" : "not_running"}
								onChange={(e) =>
									setTimerClauses((cs) =>
										cs.map((c, j) =>
											j === i
												? { ...c, wanted: e.target.value === "running" }
												: c,
										),
									)
								}
							>
								<option value="running">is running</option>
								<option value="not_running">is not running</option>
							</select>
							<Button
								size="xs"
								variant="ghost"
								onClick={() =>
									setTimerClauses((cs) => cs.filter((_, j) => j !== i))
								}
							>
								×
							</Button>
						</div>
					))}
					<Button
						size="xs"
						variant="outline"
						onClick={() =>
							setTimerClauses((cs) => [...cs, { timer: "", wanted: true }])
						}
					>
						Add timer condition
					</Button>
				</fieldset>
			)}

			<fieldset className="mt-4 space-y-2">
				<legend className="text-xs text-muted-foreground">Then do this</legend>
				{effects.map((eff, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: draft rows are positional
					<div key={i} className="flex flex-wrap items-center gap-2">
						<select
							aria-label={`Effect ${i + 1}`}
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
							label={`Effect ${i + 1} target`}
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
			</fieldset>

			{previewWhen && (
				<p className="mt-4 rounded-md bg-muted/40 px-3 py-2 text-sm italic text-muted-foreground">
					{previewWhen}
				</p>
			)}

			{error && <p className="mt-3 text-sm text-destructive">{error}</p>}

			<div className="mt-4 flex gap-2">
				<Button onClick={review} disabled={busy}>
					Review rule
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
	label,
	field,
	value,
	agreements,
	onChange,
}: {
	/** Accessible name for whichever control this renders — the row's caption
	    names the group, not the individual field (#148). */
	label: string;
	field: EventType["metadata"][string] | undefined;
	value: string;
	/** The corpus, so a condition on a citing ref is a pick (#121, ADR 0006). */
	agreements: VersionedAgreement[];
	onChange: (value: string) => void;
}) {
	// A citing ref is the *other* side of the equality the composer already picks
	// on. Leaving this a text box would reproduce exactly the failure #114 named:
	// the dom hand-types an id here, the sub picks one there, and a rule that
	// looks right silently matches nothing, for ever.
	if (field?.kind === "ref" && isCitingRef(field)) {
		const now = Date.now();
		const wanted = field.agreement_kind;
		const offered = agreementsInForce(agreements, now).filter(
			(a) => wanted === undefined || a.kind === wanted,
		);
		const known = offered.some((a) => a.id === value);
		return (
			<select
				aria-label={label}
				className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				<option value="">—</option>
				{offered.map((a) => (
					<option key={a.id} value={a.id}>
						{agreementEffectiveAt(a, now)?.name ?? a.id}
					</option>
				))}
				{/* A condition written against a since-retired term still matches the
				    events that cited it, so the rule must stay editable without
				    silently losing what it points at. */}
				{value !== "" && !known && (
					<option value={value}>{value} — no longer offered</option>
				)}
			</select>
		);
	}
	if (field?.kind === "boolean") {
		return (
			<select
				aria-label={label}
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
				aria-label={label}
				className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			>
				<option value="">—</option>
				{field.options.map((o) => (
					<option key={o} value={o}>
						{optionLabel(field, o)}
					</option>
				))}
			</select>
		);
	}
	return (
		<input
			aria-label={label}
			className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
			type={field?.kind === "number" ? "number" : "text"}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
}

/** The target picker for an effect: a counter, an anchor, an amount, or nothing. */
function EffectTarget({
	label,
	draft,
	counters,
	onChange,
}: {
	/** Accessible name stem for the row's controls — see `ConditionValue` (#148). */
	label: string;
	draft: EffectDraft;
	counters: Counter[];
	onChange: (patch: Partial<EffectDraft>) => void;
}) {
	if (draft.verb === "notify") return null;
	if (draft.verb === "reset_anchor") {
		return (
			<select
				aria-label={`${label} — clock`}
				className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
				value={draft.anchor}
				onChange={(e) => onChange({ anchor: e.target.value })}
			>
				<option value="">clock…</option>
				{DEFAULT_ANCHORS.map((a) => (
					<option key={a} value={a}>
						{anchorLabel(a)}
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
				aria-label={`${label} — counter`}
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
					aria-label={`${label} — amount`}
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

/**
 * The condition the drafts describe. One builder for the live preview and the
 * saved definition, so the sentence the author read is exactly what is stored —
 * two loops assembling the same shape is how a preview starts lying.
 *
 * An incomplete row is not a clause: a blank value, or a comparison whose value
 * is not a number, is dropped rather than coerced (coercing "" would invent
 * `false`/`0`/'' equality, and `Number("")` would invent a bound of zero).
 */
function draftCondition(
	type: EventType,
	subjectRole: Role | "",
	conditions: ConditionDraft[],
	timerClauses: TimerDraft[],
): RuleCondition {
	const metadata: RuleCondition["metadata"] = {};
	for (const c of conditions) {
		const field = c.key ? type.metadata[c.key] : undefined;
		if (!field || c.value === "") continue;
		if (c.op === "eq") {
			metadata[c.key] = coerceValue(field.kind, c.value);
			continue;
		}
		const value = Number(c.value);
		if (Number.isFinite(value)) metadata[c.key] = { op: c.op, value };
	}
	const timerActive: Record<string, boolean> = {};
	for (const t of timerClauses) {
		if (t.timer) timerActive[t.timer] = t.wanted;
	}
	return {
		type: type.id,
		...(subjectRole ? { subject_role: subjectRole } : {}),
		metadata,
		// Omitted rather than empty when unused, matching how the pack's rules and
		// every rule authored before ADR 0011 are shaped.
		...(Object.keys(timerActive).length ? { timer_active: timerActive } : {}),
	};
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
