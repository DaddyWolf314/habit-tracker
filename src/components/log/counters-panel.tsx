import { useId, useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Define } from "#/components/ui/define.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select.tsx";
import {
	adjustCounter,
	createCounter,
	deleteCounter,
	getCounterTrace,
	resetCounter,
	updateCounter,
} from "#/lib/api.ts";
import {
	agreementEffectiveAt,
	agreementsInForce,
	type VersionedAgreement,
} from "#/shared/agreements.ts";
import type {
	Counter,
	CounterReset,
	CounterRung,
	CreateCounterBody,
	TargetDirection,
} from "#/shared/counters.ts";
import type { VersionedRewardItem } from "#/shared/rewards.ts";
import type { Role, Valence } from "#/shared/roles.ts";
import type { CounterTrace } from "#/shared/trace.ts";
import { describeTraceRow, formatTime } from "./formatting.ts";

const RESET_OPTIONS: { value: CounterReset; label: string }[] = [
	{ value: "never", label: "Never (lifetime)" },
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "on_acknowledgment", label: "On acknowledgment" },
	{ value: "manual", label: "Manual" },
];

const VALENCE_OPTIONS: { value: Valence; label: string }[] = [
	{ value: "neutral", label: "Neutral" },
	{ value: "positive", label: "Positive" },
	{ value: "negative", label: "Negative" },
];

/** A streak reads its target-counter's per-period value, so its period picks
 * which target (daily vs weekly) the rollover fold checks (see `streaks.ts`). */
const STREAK_PERIOD_OPTIONS: { value: "daily" | "weekly"; label: string }[] = [
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
];

/**
 * Which way a target is met (ADR 0015). Worded as the question the couple is
 * actually answering rather than as the enum — "at least" and "at most" are the
 * words the rules editor's comparison picker already uses for the same idea.
 */
const DIRECTION_OPTIONS: { value: TargetDirection; label: string }[] = [
	{ value: "floor", label: "At least the target" },
	{ value: "cap", label: "At most the target" },
];

type CounterKind = "tally" | "streak";

/** One rung mid-edit: the threshold as typed, so a cleared field stays cleared. */
type RungDraft = { at: string; agreement_ref: string };

/**
 * The drafts as a ladder, or null if any row is half-filled. Both halves are
 * required because a rung is both (ADR 0015): the number is what the machine
 * reads, and the Agreement is what the couple agreed it costs.
 */
function parseRungs(drafts: RungDraft[]): CounterRung[] | null {
	const rungs: CounterRung[] = [];
	for (const draft of drafts) {
		const at = Number(draft.at);
		if (draft.at.trim() === "" || !Number.isInteger(at)) return null;
		if (!draft.agreement_ref) return null;
		rungs.push({ at, agreement_ref: draft.agreement_ref });
	}
	return rungs;
}

/**
 * Parses a target field: a non-negative integer, or undefined when blank/invalid.
 *
 * Zero is admitted (ADR 0015) because a **cap** of 0 is the mercy path — "a day
 * with no infractions" — and refusing it here would have quietly dropped the
 * field and saved a counter with no target at all. A floor of 0 is legal and
 * trivially met, which is meaningless rather than harmful; the form does not
 * police it, and the direction picker beside it is what makes the intent legible.
 */
function parseTarget(raw: string): number | undefined {
	const n = Number(raw);
	return raw.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The one-line policy summary under a counter's name — its cadence, any targets,
 * or, for a streak, what it tracks. */
function describeCounter(
	counter: Counter,
	nameById: Map<string, string>,
): string {
	if (counter.streak) {
		const target =
			nameById.get(counter.streak.counter) ?? counter.streak.counter;
		return withRungs(
			[`${counter.streak.period} streak of ${target}`],
			counter,
		).join(" · ");
	}
	const parts = [
		counter.reset === "never" ? "lifetime" : `resets ${counter.reset}`,
	];
	// The direction rides *inside* the target phrase rather than as a fourth part
	// (ADR 0015): "daily target 0" alone reads as a counter nobody finished
	// configuring, and the whole point of a cap is that 0 is the goal.
	const aim = counter.target_direction === "cap" ? "at most" : "at least";
	if (counter.daily_target != null)
		parts.push(`daily target ${aim} ${counter.daily_target}`);
	if (counter.weekly_target != null)
		parts.push(`weekly target ${aim} ${counter.weekly_target}`);
	return withRungs(parts, counter).join(" · ");
}

/**
 * Appends the ladder to a counter's summary line (ADR 0015) — the numbers only.
 * What each rung *means* is a term in the corpus, and a summary row is not where
 * a couple reads their terms; the banner on Today is.
 */
function withRungs(parts: string[], counter: Counter): string[] {
	if (counter.rungs.length === 0) return parts;
	const ats = [...counter.rungs]
		.sort((a, b) => a.at - b.at)
		.map((rung) => rung.at)
		.join(", ");
	return [...parts, `rungs at ${ats}`];
}

/**
 * Counters panel (handoff §4.4, §9 surface 2/6). Each counter shows its cached
 * value with +1 / −1 taps — direct manipulation that is really sugar over
 * `counter_adjusted` events — plus reset and a drill-in to its causal chain.
 * The two taps that can't be walked back, reset and delete, sit behind the
 * house two-tap inline confirm (#93).
 */
export function CountersPanel({
	counters,
	agreements,
	rewards = [],
	selfRole,
	onChange,
}: {
	counters: Counter[];
	/** The corpus a rung cites for what crossing it means (ADR 0015, ADR 0006). */
	agreements: VersionedAgreement[];
	/**
	 * The store a **price crossing** on a chain names its item through (#194, ADR
	 * 0017). Defaulted, because a caller with no store yet is a real answer and
	 * the chain degrades to the raw ref — an opaque id beats a blank, the call
	 * `describeCitation` already makes for a term the couple no longer holds.
	 */
	rewards?: VersionedRewardItem[];
	selfRole: Role | null;
	onChange: () => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [openTrace, setOpenTrace] = useState<CounterTrace | null>(null);
	// Prefix for the creator form's field ids (#148). The Radix triggers are
	// buttons, not form controls, so they take `aria-labelledby` over the caption
	// *and themselves* — naming only the caption would drop the chosen value out
	// of what a screen reader reads back.
	const ids = useId();
	const [creating, setCreating] = useState(false);
	// The counter whose definition the form is editing, or null when creating a new
	// one. The form is shared between both — edit seeds it from an existing counter.
	const [editing, setEditing] = useState<string | null>(null);
	// The row control awaiting its second tap. Delete and reset are both
	// irreversible — a reset wipes a long-running tally and the trace records it
	// but nothing restores the value — so each takes the house two-tap inline
	// guard. One at a time, so a row never shows two armed confirms at once.
	const [confirming, setConfirming] = useState<{
		id: string;
		action: "delete" | "reset";
	} | null>(null);
	const isConfirming = (id: string, action: "delete" | "reset") =>
		confirming?.id === id && confirming.action === action;
	const [kind, setKind] = useState<CounterKind>("tally");
	const [name, setName] = useState("");
	const [reset, setReset] = useState<CounterReset>("never");
	const [valence, setValence] = useState<Valence>("neutral");
	const [dailyTarget, setDailyTarget] = useState("");
	const [weeklyTarget, setWeeklyTarget] = useState("");
	const [direction, setDirection] = useState<TargetDirection>("floor");
	const [streakCounter, setStreakCounter] = useState("");
	const [streakPeriod, setStreakPeriod] = useState<"daily" | "weekly">("daily");
	// The ladder under edit, as **drafts** — the threshold is held as the raw
	// string so clearing the field reads as empty rather than snapping to 0, and
	// it is parsed once on submit (`parseRungs`). Seeded from the counter on edit
	// and submitted whole even when the editor below is hidden, so a sub saving a
	// name change cannot silently strip rungs they are not offered the controls
	// for — the same carry-through `modify_permission` gets.
	const [rungs, setRungs] = useState<RungDraft[]>([]);

	async function run(id: string, fn: () => Promise<unknown>) {
		setBusy(id);
		setError(null);
		try {
			await fn();
			onChange();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(null);
		}
	}

	function resetForm() {
		setName("");
		setKind("tally");
		setReset("never");
		setValence("neutral");
		setDailyTarget("");
		setWeeklyTarget("");
		setDirection("floor");
		setStreakCounter("");
		setStreakPeriod("daily");
		setRungs([]);
		setCreating(false);
		setEditing(null);
	}

	/** Opens the form pre-seeded from an existing counter to edit its definition. */
	function startEdit(counter: Counter) {
		setEditing(counter.id);
		setName(counter.name);
		setValence(counter.valence);
		if (counter.streak) {
			setKind("streak");
			setStreakCounter(counter.streak.counter);
			setStreakPeriod(counter.streak.period);
			setReset("never");
			setDailyTarget("");
			setWeeklyTarget("");
			setDirection("floor");
		} else {
			setKind("tally");
			setReset(counter.reset);
			setDailyTarget(
				counter.daily_target != null ? String(counter.daily_target) : "",
			);
			setWeeklyTarget(
				counter.weekly_target != null ? String(counter.weekly_target) : "",
			);
			setDirection(counter.target_direction);
			setStreakCounter("");
			setStreakPeriod("daily");
		}
		// Outside the kind branch: a streak climbs, so a ladder on one ("thirty
		// clean days") is as ordinary as a ladder on a tally.
		setRungs(
			counter.rungs.map((rung) => ({
				at: String(rung.at),
				agreement_ref: rung.agreement_ref,
			})),
		);
		setConfirming(null);
		setError(null);
		setCreating(true);
	}

	async function handleSubmit() {
		if (!name.trim()) return;
		const ladder = parseRungs(rungs);
		if (ladder === null) {
			// A rung is a whole number *and* a term. Half of one announces a crossing
			// with no consequence attached, which the server refuses too — saying it
			// here saves the round trip and keeps the half-filled row on screen.
			setError("Every rung needs a whole number and an agreement.");
			return;
		}
		const body: CreateCounterBody = {
			name: name.trim(),
			valence,
			rungs: ladder,
		};
		if (kind === "streak") {
			if (!streakCounter) {
				setError("Pick a counter for the streak to track.");
				return;
			}
			// A streak's value is folded at rollover, not cleared on a cadence.
			body.reset = "never";
			body.streak = { counter: streakCounter, period: streakPeriod };
		} else {
			body.reset = reset;
			body.daily_target = parseTarget(dailyTarget);
			body.weekly_target = parseTarget(weeklyTarget);
			body.target_direction = direction;
		}
		const id = editing;
		await run(id ?? "__new__", async () => {
			if (id) {
				// The form doesn't expose modify_permission, so carry the counter's
				// existing value through — omitting it resets to the schema default.
				const original = counters.find((c) => c.id === id);
				await updateCounter(id, {
					...body,
					modify_permission: original?.modify_permission,
				});
			} else {
				await createCounter(body);
			}
			resetForm();
		});
	}

	// A streak reads its target-counter's per-period value, so only counters that
	// carry a target for the chosen period can be tracked. Streak counters have no
	// target of their own, so they fall out here naturally.
	// A counter can't track itself, so the one being edited is never a target.
	const targetableCounters = counters.filter(
		(c) =>
			c.id !== editing &&
			(streakPeriod === "daily"
				? c.daily_target != null
				: c.weekly_target != null),
	);

	const nameById = new Map(counters.map((c) => [c.id, c.name]));

	const canAuthorRungs = selfRole === "dom" || selfRole === "switch";

	const valenceTint: Record<string, string> = {
		positive: "text-emerald-600",
		negative: "text-rose-600",
		neutral: "text-foreground",
	};

	// The tint above is the only thing carrying valence, which leaves colorblind
	// and grayscale readers nothing (#148). Text rather than a sign or an icon:
	// the row is dense and the glyph would have to compete with the tap targets
	// #147 just sized, so the cue goes where it costs no pixels.
	const valenceCue: Record<string, string> = {
		positive: "positive counter",
		negative: "negative counter",
		neutral: "neutral counter",
	};

	return (
		<section className="rounded-lg border p-4">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold">Counters</h2>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => (creating ? resetForm() : setCreating(true))}
				>
					{creating ? "Cancel" : "New counter"}
				</Button>
			</div>

			{/*
			 * Three of the app's words, defined where they are used (#212 item 4).
			 * All three live on a counter, which is why they are one toggle rather
			 * than three: someone meeting "streak" is a line away from meeting
			 * "counter", and picking which word you are confused about before finding
			 * out is not a choice worth offering.
			 *
			 * The rung definition sits *here* rather than only in `RungEditor` below,
			 * which renders for a dom or switch and only while the form is open — a
			 * sub reading a counter's rungs would otherwise find the word explained
			 * nowhere on this screen.
			 */}
			<Define terms={["counter", "streak", "rung"]} />

			{/* Every picker in this form sits at the `h-11` tap-target floor (#147),
			    the same height as the `Input`s beside them — which is what CLAUDE.md
			    means by a field and the control next to it lining up "by
			    construction". They were `size="sm"` until #193: not because any row
			    here cannot spare the height, which is the only reason to go under the
			    floor, but because the first one was written that way and each new one
			    copied it. The row buttons below keep `sm`, deliberately — a dense
			    list row of secondary actions is exactly what that size is for. */}
			{creating && (
				<div className="mt-3 space-y-2">
					<Input
						aria-label="Counter name"
						placeholder="Counter name"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<div className="flex flex-wrap gap-2">
						<div className="flex flex-col gap-1 text-xs text-muted-foreground">
							<span id={`${ids}-kind-label`}>Type</span>
							<Select
								value={kind}
								onValueChange={(v) => setKind(v as CounterKind)}
							>
								<SelectTrigger
									id={`${ids}-kind`}
									aria-labelledby={`${ids}-kind-label ${ids}-kind`}
									className="w-44"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="tally">Tally</SelectItem>
									<SelectItem value="streak">Streak</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1 text-xs text-muted-foreground">
							<span id={`${ids}-valence-label`}>Valence</span>
							<Select
								value={valence}
								onValueChange={(v) => setValence(v as Valence)}
							>
								<SelectTrigger
									id={`${ids}-valence`}
									aria-labelledby={`${ids}-valence-label ${ids}-valence`}
									className="w-44"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{VALENCE_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{kind === "tally" ? (
						<div className="flex flex-wrap gap-2">
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<span id={`${ids}-reset-label`}>Resets</span>
								<Select
									value={reset}
									onValueChange={(v) => setReset(v as CounterReset)}
								>
									<SelectTrigger
										id={`${ids}-reset`}
										aria-labelledby={`${ids}-reset-label ${ids}-reset`}
										className="w-44"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{RESET_OPTIONS.map((o) => (
											<SelectItem key={o.value} value={o.value}>
												{o.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<label htmlFor={`${ids}-daily`}>Daily target</label>
								<Input
									id={`${ids}-daily`}
									type="number"
									min="0"
									placeholder="none"
									className="w-24"
									value={dailyTarget}
									onChange={(e) => setDailyTarget(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<label htmlFor={`${ids}-weekly`}>Weekly target</label>
								<Input
									id={`${ids}-weekly`}
									type="number"
									min="0"
									placeholder="none"
									className="w-24"
									value={weeklyTarget}
									onChange={(e) => setWeeklyTarget(e.target.value)}
								/>
							</div>
							{/* One direction for both targets (ADR 0015) — a counter is one
							    kind of thing, and a daily floor beside a weekly cap describes
							    no counter anyone wants. */}
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<span id={`${ids}-direction-label`}>Met by</span>
								<Select
									value={direction}
									onValueChange={(v) => setDirection(v as TargetDirection)}
								>
									<SelectTrigger
										id={`${ids}-direction`}
										aria-labelledby={`${ids}-direction-label ${ids}-direction`}
										className="w-44"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{DIRECTION_OPTIONS.map((o) => (
											<SelectItem key={o.value} value={o.value}>
												{o.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					) : (
						<div className="flex flex-wrap gap-2">
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<span id={`${ids}-tracks-label`}>Tracks</span>
								<Select value={streakCounter} onValueChange={setStreakCounter}>
									<SelectTrigger
										id={`${ids}-tracks`}
										aria-labelledby={`${ids}-tracks-label ${ids}-tracks`}
										className="w-56"
									>
										<SelectValue placeholder="Choose a counter…" />
									</SelectTrigger>
									<SelectContent>
										{targetableCounters.length === 0 && (
											<div className="px-2 py-1.5 text-xs text-muted-foreground">
												No eligible counters — create one with a target first.
											</div>
										)}
										{targetableCounters.map((c) => (
											<SelectItem key={c.id} value={c.id}>
												{c.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<span id={`${ids}-period-label`}>Period</span>
								<Select
									value={streakPeriod}
									onValueChange={(v) => {
										setStreakPeriod(v as "daily" | "weekly");
										// The eligible set is period-scoped; drop a now-invalid pick.
										setStreakCounter("");
									}}
								>
									<SelectTrigger
										id={`${ids}-period`}
										aria-labelledby={`${ids}-period-label ${ids}-period`}
										className="w-32"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{STREAK_PERIOD_OPTIONS.map((o) => (
											<SelectItem key={o.value} value={o.value}>
												{o.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					)}

					{kind === "streak" && (
						<p className="text-xs text-muted-foreground">
							Each {streakPeriod === "daily" ? "day" : "week"} the streak grows
							by 1 if the tracked counter met its {streakPeriod} target, or
							resets to 0 if it didn't. A counter whose target is a cap is met
							by staying under it, which is how a streak counts clean{" "}
							{streakPeriod === "daily" ? "days" : "weeks"}.
						</p>
					)}

					{/* Authoring is dom/switch, like rule authoring and for the same
					    reason: a rung says what a counter costs. Reading is not gated —
					    the banner on Today shows both partners the same ladder (ADR
					    0015) — and a hidden editor still submits the rungs it was
					    seeded with, so nothing is stripped by the partner who cannot
					    edit it. */}
					{canAuthorRungs && (
						<RungEditor
							rungs={rungs}
							agreements={agreements}
							idPrefix={ids}
							onChange={setRungs}
						/>
					)}

					<Button
						onClick={handleSubmit}
						disabled={busy === (editing ?? "__new__")}
					>
						{editing ? "Save changes" : "Create"}
					</Button>
				</div>
			)}

			{error && <p className="mt-3 text-sm text-destructive">{error}</p>}

			<ul className="mt-3 divide-y">
				{counters.length === 0 && (
					<li className="py-3 text-sm text-muted-foreground">
						No counters yet — create one to start a shared tally.
					</li>
				)}
				{counters.map((counter) => (
					<li key={counter.id} className="flex items-center gap-3 py-3">
						<div className="min-w-0 flex-1">
							<button
								type="button"
								className="truncate text-left text-sm font-medium hover:underline"
								onClick={() =>
									run(counter.id, async () =>
										setOpenTrace(await getCounterTrace(counter.id)),
									)
								}
							>
								{counter.name}
							</button>
							<div className="text-xs text-muted-foreground">
								{describeCounter(counter, nameById)}
							</div>
						</div>
						<span
							className={`w-10 text-right text-lg font-semibold tabular-nums ${valenceTint[counter.valence] ?? ""}`}
						>
							{counter.value}
							<span className="sr-only">
								{valenceCue[counter.valence] ?? ""}
							</span>
						</span>
						<div className="flex flex-wrap justify-end gap-1">
							<Button
								variant="outline"
								size="sm"
								disabled={busy === counter.id}
								onClick={() =>
									run(counter.id, () => adjustCounter(counter.id, -1))
								}
							>
								−1
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={busy === counter.id}
								onClick={() =>
									run(counter.id, () => adjustCounter(counter.id, 1))
								}
							>
								+1
							</Button>
							{isConfirming(counter.id, "reset") ? (
								<InlineConfirm
									label="Yes, reset"
									busy={busy === counter.id}
									onConfirm={() =>
										run(counter.id, async () => {
											await resetCounter(counter.id);
											setConfirming(null);
										})
									}
									onCancel={() => setConfirming(null)}
								/>
							) : (
								<Button
									variant="ghost"
									size="sm"
									disabled={busy === counter.id}
									onClick={() =>
										setConfirming({ id: counter.id, action: "reset" })
									}
								>
									Reset
								</Button>
							)}
							<Button
								variant="ghost"
								size="sm"
								disabled={busy === counter.id}
								onClick={() => startEdit(counter)}
							>
								Edit
							</Button>
							{isConfirming(counter.id, "delete") ? (
								<InlineConfirm
									label="Yes, delete"
									busy={busy === counter.id}
									onConfirm={() =>
										run(counter.id, async () => {
											await deleteCounter(counter.id);
											setConfirming(null);
											if (editing === counter.id) resetForm();
										})
									}
									onCancel={() => setConfirming(null)}
								/>
							) : (
								<Button
									variant="ghost"
									size="sm"
									className="text-destructive"
									disabled={busy === counter.id}
									onClick={() =>
										setConfirming({ id: counter.id, action: "delete" })
									}
								>
									Delete
								</Button>
							)}
						</div>
					</li>
				))}
			</ul>

			{openTrace && (
				<CounterTraceSheet
					trace={openTrace}
					agreements={agreements}
					rewards={rewards}
					onClose={() => setOpenTrace(null)}
				/>
			)}
		</section>
	);
}

/**
 * The ladder editor (ADR 0015): each row a threshold and the term the couple
 * agreed it costs.
 *
 * The consequence is picked, never typed. It lives in the consent corpus so that
 * changing what a demerit costs shows up as a change to a *term* — versioned,
 * counted in the partner's badge, and written into consent history — which a
 * prose field on the counter would quietly route around (ADR 0006).
 *
 * Only terms **in force** are offered, for the reason `ref-candidates.ts` gives:
 * a retired term still resolves for every past crossing that cited it, and still
 * renders on a standing rung, but it is not something to newly bind yourself to.
 */
function RungEditor({
	rungs,
	agreements,
	idPrefix,
	onChange,
}: {
	rungs: RungDraft[];
	agreements: VersionedAgreement[];
	idPrefix: string;
	onChange: (rungs: RungDraft[]) => void;
}) {
	const now = Date.now();
	const options = agreementsInForce(agreements, now).map((agreement) => ({
		id: agreement.id,
		name: agreementEffectiveAt(agreement, now)?.name ?? agreement.id,
	}));

	function update(index: number, patch: Partial<RungDraft>) {
		onChange(rungs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
	}

	return (
		<div className="space-y-2 rounded-md border border-dashed p-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium">Rungs</span>
				<Button
					variant="ghost"
					size="xs"
					disabled={options.length === 0}
					onClick={() => onChange([...rungs, { at: "", agreement_ref: "" }])}
				>
					Add rung
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				Crossing one is announced to you both and shows on Today while the
				counter stays at or above it. Nothing fires — what happens next is
				whatever you agreed, and any rule you wrote to read the number.
			</p>
			{options.length === 0 && (
				<p className="text-xs text-muted-foreground">
					Write an agreement first — a rung says which one it costs.
				</p>
			)}
			{rungs.map((rung, index) => (
				<div
					// Position is the identity here: a rung has no id, and two rows may
					// legitimately be blank at once while the couple fills them in.
					// biome-ignore lint/suspicious/noArrayIndexKey: a draft row has no other identity
					key={index}
					className="flex flex-wrap items-end gap-2"
				>
					<div className="flex flex-col gap-1 text-xs text-muted-foreground">
						<label htmlFor={`${idPrefix}-rung-${index}`}>At</label>
						<Input
							id={`${idPrefix}-rung-${index}`}
							type="number"
							placeholder="10"
							className="w-24"
							value={rung.at}
							onChange={(e) => update(index, { at: e.target.value })}
						/>
					</div>
					<div className="flex flex-col gap-1 text-xs text-muted-foreground">
						<span id={`${idPrefix}-rung-${index}-term-label`}>Means</span>
						<Select
							value={rung.agreement_ref}
							onValueChange={(v) => update(index, { agreement_ref: v })}
						>
							<SelectTrigger
								id={`${idPrefix}-rung-${index}-term`}
								aria-labelledby={`${idPrefix}-rung-${index}-term-label ${idPrefix}-rung-${index}-term`}
								className="w-56"
							>
								<SelectValue placeholder="Choose an agreement…" />
							</SelectTrigger>
							<SelectContent>
								{options.map((option) => (
									<SelectItem key={option.id} value={option.id}>
										{option.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="text-destructive"
						onClick={() => onChange(rungs.filter((_, i) => i !== index))}
					>
						Remove
					</Button>
				</div>
			))}
		</div>
	);
}

/** The causal chain behind one counter — the consent-record + debug view. */
function CounterTraceSheet({
	trace,
	agreements,
	rewards,
	onClose,
}: {
	trace: CounterTrace;
	/** So a crossing on this chain names the term it cites (ADR 0015). */
	agreements: VersionedAgreement[];
	/** So a price crossing names the item it made affordable (ADR 0017). */
	rewards: VersionedRewardItem[];
	onClose: () => void;
}) {
	const now = Date.now();
	return (
		<div className="mt-4 rounded-md border border-primary/40 bg-primary/5 p-4">
			<div className="flex items-center justify-between">
				<p className="text-sm font-medium">
					Chain for {trace.counter_id} — now {trace.value}
				</p>
				<Button variant="ghost" size="sm" onClick={onClose}>
					Close
				</Button>
			</div>
			<ol className="mt-2 space-y-1 text-xs text-muted-foreground">
				{trace.rows.length === 0 && <li>No changes yet.</li>}
				{trace.rows.map((row) => {
					// The typed detail replaces the old ad-hoc JSON.parse: a counter change
					// renders its compact +delta form here; anything else (a scheduled
					// reset, a streak fold) borrows the ledger's own chain phrasing.
					const d = row.detail;
					let label: string;
					if (d.kind === "counter") {
						const delta = d.to - d.from;
						label =
							d.op === "reset"
								? "reset → 0"
								: `${delta >= 0 ? "+" : ""}${delta} (${d.from} → ${d.to})`;
					} else {
						const line = describeTraceRow(row, { agreements, rewards, now });
						// The note carries a crossing's term; a chain line is one row, so it
						// rides beside the summary rather than wrapping underneath it.
						label = line.note ? `${line.summary} — ${line.note}` : line.summary;
					}
					return (
						<li key={row.id} className="flex justify-between gap-2">
							<span>{label}</span>
							<span className="shrink-0">{formatTime(row.at)}</span>
						</li>
					);
				})}
			</ol>
		</div>
	);
}
