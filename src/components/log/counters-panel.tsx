import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
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
import type {
	Counter,
	CounterReset,
	CreateCounterBody,
} from "#/shared/counters.ts";
import type { Valence } from "#/shared/roles.ts";
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

type CounterKind = "tally" | "streak";

/** Parses a target field: a positive integer, or undefined when blank/invalid. */
function parseTarget(raw: string): number | undefined {
	const n = Number(raw);
	return raw.trim() !== "" && Number.isInteger(n) && n > 0 ? n : undefined;
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
		return `${counter.streak.period} streak of ${target}`;
	}
	const parts = [
		counter.reset === "never" ? "lifetime" : `resets ${counter.reset}`,
	];
	if (counter.daily_target != null)
		parts.push(`daily target ${counter.daily_target}`);
	if (counter.weekly_target != null)
		parts.push(`weekly target ${counter.weekly_target}`);
	return parts.join(" · ");
}

/**
 * Counters panel (handoff §4.4, §9 surface 2/6). Each counter shows its cached
 * value with +1 / −1 taps — direct manipulation that is really sugar over
 * `counter_adjusted` events — plus reset and a drill-in to its causal chain.
 */
export function CountersPanel({
	counters,
	onChange,
}: {
	counters: Counter[];
	onChange: () => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [openTrace, setOpenTrace] = useState<CounterTrace | null>(null);
	const [creating, setCreating] = useState(false);
	// The counter whose definition the form is editing, or null when creating a new
	// one. The form is shared between both — edit seeds it from an existing counter.
	const [editing, setEditing] = useState<string | null>(null);
	// The counter awaiting a delete confirmation (delete is a two-tap inline guard).
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [kind, setKind] = useState<CounterKind>("tally");
	const [name, setName] = useState("");
	const [reset, setReset] = useState<CounterReset>("never");
	const [valence, setValence] = useState<Valence>("neutral");
	const [dailyTarget, setDailyTarget] = useState("");
	const [weeklyTarget, setWeeklyTarget] = useState("");
	const [streakCounter, setStreakCounter] = useState("");
	const [streakPeriod, setStreakPeriod] = useState<"daily" | "weekly">("daily");

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
		setStreakCounter("");
		setStreakPeriod("daily");
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
		} else {
			setKind("tally");
			setReset(counter.reset);
			setDailyTarget(
				counter.daily_target != null ? String(counter.daily_target) : "",
			);
			setWeeklyTarget(
				counter.weekly_target != null ? String(counter.weekly_target) : "",
			);
			setStreakCounter("");
			setStreakPeriod("daily");
		}
		setConfirmDelete(null);
		setError(null);
		setCreating(true);
	}

	async function handleSubmit() {
		if (!name.trim()) return;
		const body: CreateCounterBody = { name: name.trim(), valence };
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

	const valenceTint: Record<string, string> = {
		positive: "text-emerald-600",
		negative: "text-rose-600",
		neutral: "text-foreground",
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

			{creating && (
				<div className="mt-3 space-y-2">
					<Input
						placeholder="Counter name"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<div className="flex flex-wrap gap-2">
						<div className="flex flex-col gap-1 text-xs text-muted-foreground">
							<span>Type</span>
							<Select
								value={kind}
								onValueChange={(v) => setKind(v as CounterKind)}
							>
								<SelectTrigger size="sm" className="w-44">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="tally">Tally</SelectItem>
									<SelectItem value="streak">Streak</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1 text-xs text-muted-foreground">
							<span>Valence</span>
							<Select
								value={valence}
								onValueChange={(v) => setValence(v as Valence)}
							>
								<SelectTrigger size="sm" className="w-44">
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
								<span>Resets</span>
								<Select
									value={reset}
									onValueChange={(v) => setReset(v as CounterReset)}
								>
									<SelectTrigger size="sm" className="w-44">
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
								<span>Daily target</span>
								<Input
									type="number"
									min="1"
									placeholder="none"
									className="w-24"
									value={dailyTarget}
									onChange={(e) => setDailyTarget(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<span>Weekly target</span>
								<Input
									type="number"
									min="1"
									placeholder="none"
									className="w-24"
									value={weeklyTarget}
									onChange={(e) => setWeeklyTarget(e.target.value)}
								/>
							</div>
						</div>
					) : (
						<div className="flex flex-wrap gap-2">
							<div className="flex flex-col gap-1 text-xs text-muted-foreground">
								<span>Tracks</span>
								<Select value={streakCounter} onValueChange={setStreakCounter}>
									<SelectTrigger size="sm" className="w-56">
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
								<span>Period</span>
								<Select
									value={streakPeriod}
									onValueChange={(v) => {
										setStreakPeriod(v as "daily" | "weekly");
										// The eligible set is period-scoped; drop a now-invalid pick.
										setStreakCounter("");
									}}
								>
									<SelectTrigger size="sm" className="w-32">
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
							by 1 if the tracked counter hit its {streakPeriod} target, or
							resets to 0 if it didn't.
						</p>
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
							<Button
								variant="ghost"
								size="sm"
								disabled={busy === counter.id}
								onClick={() => run(counter.id, () => resetCounter(counter.id))}
							>
								Reset
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy === counter.id}
								onClick={() => startEdit(counter)}
							>
								Edit
							</Button>
							{confirmDelete === counter.id ? (
								<>
									<Button
										variant="ghost"
										size="sm"
										className="text-destructive"
										disabled={busy === counter.id}
										onClick={() =>
											run(counter.id, async () => {
												await deleteCounter(counter.id);
												setConfirmDelete(null);
												if (editing === counter.id) resetForm();
											})
										}
									>
										Confirm
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setConfirmDelete(null)}
									>
										No
									</Button>
								</>
							) : (
								<Button
									variant="ghost"
									size="sm"
									className="text-destructive"
									disabled={busy === counter.id}
									onClick={() => setConfirmDelete(counter.id)}
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
					onClose={() => setOpenTrace(null)}
				/>
			)}
		</section>
	);
}

/** The causal chain behind one counter — the consent-record + debug view. */
function CounterTraceSheet({
	trace,
	onClose,
}: {
	trace: CounterTrace;
	onClose: () => void;
}) {
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
						label = describeTraceRow(row).summary;
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
