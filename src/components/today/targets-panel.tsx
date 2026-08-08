import { useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Explainer } from "#/components/ui/explainer.tsx";
import { logEvent } from "#/lib/api.ts";
import {
	agreementNamesAt,
	type VersionedAgreement,
} from "#/shared/agreements.ts";
import type { Counter } from "#/shared/counters.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { Rule } from "#/shared/rules.ts";
import { type TargetRow, targetRows } from "#/shared/target-rows.ts";
import { describeTargets, describeTracking } from "#/shared/today-describe.ts";

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
 *
 * The heading was **Today**, inside the page titled Today (#212 item 2). Two
 * headings deep in the same word says nothing about either, and this one is the
 * panel a new couple meets first — the seeded row #214 exists to account for is
 * in here. The phrase that replaces it is the one Today's own floor already uses
 * for this panel ("what you're aiming at, what's running, and anything waiting on
 * one of you"), so the screen names its parts the same way twice.
 */
export function TargetsPanel({
	counters,
	rules,
	types,
	agreements = [],
	onChange,
}: {
	counters: Counter[];
	/** The rules in force, which say which counter counts what (#121). */
	rules: Rule[];
	types: EventType[];
	/**
	 * The corpus, for naming the term a row counts (#212 item 5). Defaulted, so a
	 * caller with nothing loaded yet degrades to the relationship without the name
	 * rather than to a blank row — the call {@link describeTracking} makes for a
	 * term the couple no longer holds.
	 */
	agreements?: VersionedAgreement[];
	onChange: () => void;
}) {
	const rows = targetRows({ counters, rules, types });
	// The version in force now, not at some past event: a row says what this
	// counter counts from here on, which is the clock `agreementNamesAt` argues.
	//
	// Memoised on the corpus alone, exactly as `rules-view.tsx` does it. Today
	// polls, so this component re-renders on a timer whether or not anything it
	// reads has moved, and rebuilding a map over the whole corpus each time is
	// work for an answer that only changes when a term is revised. `Date.now()` is
	// deliberately not a dependency: a rename arrives with the poll that carries
	// the corpus, and treating the clock as an input would defeat the memo on
	// every tick to catch a boundary nothing here turns on.
	const termNames = useMemo(
		() => agreementNamesAt(agreements, Date.now()),
		[agreements],
	);
	if (rows.length === 0) return null;

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">What you're aiming at</h2>
			<Explainer label="What is this?">
				<p>
					A counter with a target on it — for today, or for the week. The number
					is folded out of your log, so the button logs the event ("I did the
					morning kneel") and the count follows from it. Nothing here edits a
					number directly.
				</p>
				<p>{describeTargets(rows)}</p>
			</Explainer>
			<ul className="mt-3 space-y-2">
				{rows.map((row) => (
					<li key={row.counter.id}>
						<TargetLine
							row={row}
							tracking={describeTracking(row, termNames)}
							onChange={onChange}
						/>
					</li>
				))}
			</ul>
		</section>
	);
}

/** One target: where it stands, its streak, and its tick if it has one. */
function TargetLine({
	row,
	tracking,
	onChange,
}: {
	row: TargetRow;
	/** Where this row came from, or null when the rules cite no term (#212). */
	tracking: string | null;
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
			{/* Under the row rather than beside the name: it is provenance, not part
			    of what the row currently reads, and the glance this panel exists for
			    is the number. */}
			{tracking && (
				<p className="mt-1 text-xs text-muted-foreground">{tracking}</p>
			)}
			{error && <p className="mt-1 text-xs text-destructive">{error}</p>}
		</div>
	);
}
