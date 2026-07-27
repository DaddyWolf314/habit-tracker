import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { logEvent } from "#/lib/api.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { Rule } from "#/shared/rules.ts";
import { type TargetRow, targetRows } from "#/shared/target-rows.ts";

/**
 * What you are aiming at today (#135, handoff §9.2 — "today's counter targets").
 *
 * Only counters carrying a target appear, and a **streak renders inside its
 * target's row** rather than beside it: `CONTEXT.md` §Target counter calls a
 * streak "a property of one", so a sibling row would contradict the model on
 * screen. The Log's counters panel is still where every counter lives.
 *
 * A row is tickable only where the rules say what the counter counts, and the
 * tick logs the **event**, never the counter. The Log's panel has a `+1`, and
 * reusing it here would append a `counter_adjusted` recording "the number went
 * up" instead of "I did the morning kneel" — no rule fires, no term is cited,
 * and per-ritual history sees nothing. The streak would still move, so it would
 * look like it worked.
 */
export function TargetsPanel({
	counters,
	rules,
	types,
	onChange,
}: {
	counters: Counter[];
	/** The rules in force, which say which counter counts what (#121). */
	rules: Rule[];
	types: EventType[];
	onChange: () => void;
}) {
	const rows = targetRows({ counters, rules, types });
	if (rows.length === 0) return null;

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Today</h2>
			<ul className="mt-3 space-y-2">
				{rows.map((row) => (
					<li key={row.counter.id}>
						<TargetLine row={row} onChange={onChange} />
					</li>
				))}
			</ul>
		</section>
	);
}

/** One target: where it stands, its streak, and its tick if it has one. */
function TargetLine({
	row,
	onChange,
}: {
	row: TargetRow;
	onChange: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function tick() {
		if (!row.tickLogs) return;
		setBusy(true);
		setError(null);
		try {
			await logEvent({
				type: row.tickLogs.type,
				metadata: row.tickLogs.metadata,
			});
			onChange();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't log that.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-md bg-muted/40 px-3 py-2">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="font-medium">
						{row.counter.name}
						{row.period === "weekly" && (
							<span className="ml-2 text-xs text-muted-foreground">
								this week
							</span>
						)}
					</div>
					{row.streak !== null && (
						<div className="text-xs text-muted-foreground">
							{row.streak.length === 0
								? "no streak yet"
								: `${row.streak.length}-${
										row.streak.period === "weekly" ? "week" : "day"
									} streak`}
						</div>
					)}
				</div>
				<span className="shrink-0 text-sm font-semibold tabular-nums">
					{row.counter.value} / {row.target}
					{row.met && <span className="ml-1">✓</span>}
				</span>
				{row.tickLogs && (
					<Button size="xs" onClick={tick} disabled={busy}>
						{busy ? "…" : "Log it"}
					</Button>
				)}
			</div>
			{error && <p className="mt-1 text-xs text-destructive">{error}</p>}
		</div>
	);
}
