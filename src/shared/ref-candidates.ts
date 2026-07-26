import { EXPIRED_PROMPT_GRACE_MS } from "#/templates/index.ts";
import type { Rule } from "./rules.ts";
import {
	countdownRemainingMs,
	formatElapsed,
	formatRemaining,
	isCountdownExpired,
	type TimerView,
	toCountdown,
} from "./timers.ts";

/**
 * Ref candidates (#89, CONTEXT §Ref) — the pure half of the ref picker,
 * isomorphic and free of storage/runtime deps like `timers.ts` and
 * `journaling.ts`, so it is unit-testable in plain Node.
 *
 * A ref field is either *originating* (the event mints the id) or *echoing* (it
 * repeats an id minted elsewhere, to pair with it). Only an echoing ref has
 * candidates, and the couple's own rules already say which is which: a rule that
 * fires on the type and **closes a timer by matching that metadata key** is
 * exactly the statement "this key names an existing row". So the candidate list
 * is derived, never a hardcoded key list — a custom type closing a custom timer
 * gets a picker for free, and a key no rule matches on falls back to free text.
 *
 * Matching is strict equality (handoff §4.3), so a hand-typed ref that is one
 * character off logs fine and then closes nothing: the countdown runs on to
 * `expired` and the near-miss trace lands on the *matching* event, i.e. never.
 * Picking from the candidates is what removes that failure mode.
 */
export interface RefCandidate {
	/** The id to submit as the metadata value — a real candidate's match value. */
	value: string;
	/** What the picker shows: what the ref names, plus how long it has run or has left. */
	label: string;
}

/**
 * Where a close rule reads its match value from: the timer definition it closes
 * and the *timer-side* key holding the id. `match_on` is timer key → event key,
 * so a rule pairing `timer.slot` with `event.session_id` means the value the
 * event must echo lives on the timer under `slot`.
 */
interface ClosingMatch {
	timer: string;
	timerKey: string;
}

/**
 * The timer definitions an event of `typeId` would close by matching on `key`.
 * Disabled rules are skipped, exactly as `evaluateRules` skips them — a picker
 * must offer only what a close would really find.
 */
function closingMatches(rules: Rule[], typeId: string, key: string) {
	const matches: ClosingMatch[] = [];
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		if (rule.condition.type !== typeId) continue;
		for (const effect of rule.effects) {
			if (effect.verb !== "close_timer" || !effect.match_on) continue;
			for (const [timerKey, eventKey] of Object.entries(effect.match_on)) {
				if (eventKey === key) matches.push({ timer: effect.timer, timerKey });
			}
		}
	}
	return matches;
}

/**
 * Whether a timer is a candidate. Open is the obvious case; a countdown that has
 * expired stays one for a while too, on #102's reasoning for a late journal
 * answer — echoing late still pairs the event to the right ref for history, it
 * just no longer discharges the countdown. Dropping it the moment the deadline
 * passed would fall back to free text exactly when the author is latest, most
 * rushed, and most likely to mistype.
 *
 * Only `expired` earns that grace: a `completed`, `canceled`, `failed`, or
 * `auto_closed` row was resolved, and naming it again means nothing. The window
 * is the one an expired prompt already gets, since it is the same judgement
 * about the same kind of lateness.
 */
function isCandidate(t: TimerView, now: number): boolean {
	if (t.status === null) return true;
	return (
		t.status === "expired" &&
		t.closed_at !== null &&
		t.closed_at >= now - EXPIRED_PROMPT_GRACE_MS
	);
}

/**
 * One candidate's timing, which is what makes the option recognizable: a
 * countdown reads as the time it has left, a stopwatch as the time it has run.
 * A paused countdown keeps its frozen remaining beside the marker, so two paused
 * rows still read apart.
 *
 * Past the deadline it reads `overdue` whether or not the expiry sweep has
 * landed. The two states differ in the model — an unswept countdown is still
 * open and a close would discharge it — but which one the client is looking at
 * turns on alarm timing and poll lag, not on anything the author did, so
 * splitting the word would flip it under them for no reason they can see.
 * `overdue` is also what the prompt picker says (#102), so the two read alike.
 */
function timingOf(t: TimerView, now: number): string {
	if (t.status === "expired") return "overdue";
	if (t.kind === "countdown") {
		const c = toCountdown(t);
		if (isCountdownExpired(c, now)) return "overdue";
		const left = `${formatRemaining(countdownRemainingMs(c, now))} left`;
		return t.paused_at != null ? `${left} (paused)` : left;
	}
	return formatElapsed(now - (t.opened_at ?? now));
}

/**
 * The open timers an event of `typeId` could close through its `key` ref, as
 * picker options in the order the caller supplied them (the API's newest-first).
 * Empty when the ref originates its id, when no rule matches a timer on the key,
 * or when nothing qualifies — all three of which leave the field as free text.
 * What qualifies is {@link isCandidate}. One option per distinct id; ids sharing
 * a label (two stopwatches on the same activity) are disambiguated by the tail
 * of the id.
 */
export function refCandidates({
	rules,
	timers,
	typeId,
	key,
	now,
}: {
	rules: Rule[];
	timers: TimerView[];
	typeId: string;
	key: string;
	now: number;
}): RefCandidate[] {
	const matches = closingMatches(rules, typeId, key);
	if (matches.length === 0) return [];

	// One row per distinct id, and specifically the *oldest* — a close resolves
	// oldest-open-wins (`matchStopwatch` reads rows ordered by `opened_at`), so a
	// label taken from any other row would describe a countdown the event is not
	// about to discharge. Two rows can share an id only while refs are still
	// hand-named; ADR 0005 removes that by minting them.
	const byValue = new Map<string, TimerView>();
	for (const t of timers) {
		if (!isCandidate(t, now)) continue;
		for (const { timer, timerKey } of matches) {
			if (t.timer !== timer) continue;
			const raw = t.match[timerKey];
			if (raw === undefined || raw === "") continue;
			const value = String(raw);
			const prior = byValue.get(value);
			if (prior && (prior.opened_at ?? 0) <= (t.opened_at ?? 0)) continue;
			byValue.set(value, t);
		}
	}

	// The tag is the human name where there is one (a stopwatch's activity);
	// otherwise the id itself is the name (a task countdown's `dishes`).
	const candidates = [...byValue].map(([value, t]) => ({
		value,
		label: `${t.tag ?? value} — ${timingOf(t, now)}`,
	}));
	const seen = new Map<string, number>();
	for (const c of candidates) {
		seen.set(c.label, (seen.get(c.label) ?? 0) + 1);
	}
	return candidates.map((c) =>
		(seen.get(c.label) ?? 0) > 1
			? { ...c, label: `${c.label} · …${c.value.slice(-4)}` }
			: c,
	);
}
