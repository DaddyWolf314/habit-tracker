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
	getCounterTrace,
	resetCounter,
} from "#/lib/api.ts";
import type { Counter, CounterReset } from "#/shared/counters.ts";
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
	const [name, setName] = useState("");
	const [reset, setReset] = useState<CounterReset>("never");
	const [valence, setValence] = useState<Valence>("neutral");

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

	async function handleCreate() {
		if (!name.trim()) return;
		await run("__new__", async () => {
			await createCounter({ name: name.trim(), reset, valence });
			setName("");
			setReset("never");
			setValence("neutral");
			setCreating(false);
		});
	}

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
					onClick={() => setCreating((c) => !c)}
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
					<Button onClick={handleCreate} disabled={busy === "__new__"}>
						Create
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
								{counter.reset === "never"
									? "lifetime"
									: `resets ${counter.reset}`}
							</div>
						</div>
						<span
							className={`w-10 text-right text-lg font-semibold tabular-nums ${valenceTint[counter.valence] ?? ""}`}
						>
							{counter.value}
						</span>
						<div className="flex gap-1">
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
