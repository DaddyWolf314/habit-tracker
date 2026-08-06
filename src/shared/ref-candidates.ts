import { EXPIRED_PROMPT_GRACE_MS } from "#/templates/index.ts";
import {
	agreementEffectiveAt,
	agreementsInForce,
	type VersionedAgreement,
} from "./agreements.ts";
import type { MetadataField } from "./event-types.ts";
import { isCitingRef, isOriginatingRef } from "./refs.ts";
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
interface TimerMatch {
	timer: string;
	timerKey: string;
	/**
	 * Whether an event of the *asking* type would close this timer through this
	 * key — i.e. *some* enabled rule conditioning on `typeId` closes this timer on
	 * this key. Folded across every rule reaching the same timer/key pair, not read
	 * off one of them: a second rule closing the same pair from another type says
	 * nothing about whether this type discharges the row, and letting it answer
	 * would hand a closer the resolved rows an echo gets. Drives candidacy: a
	 * closer may only name a row it could really discharge, an echo may name a
	 * resolved one ({@link isCandidate}).
	 */
	closes: boolean;
}

/**
 * The timer definitions `key` names, one entry per timer/key pair, and whether
 * an event of `typeId` would *close* each one. Disabled rules are skipped,
 * exactly as `evaluateRules` skips them — a picker must offer only what a close
 * would really find.
 *
 * Deliberately not filtered to rules on `typeId` (#182). A rule matching a timer
 * on key K is the statement "K names an existing row", and that is true of the
 * key wherever it appears — whether or not the event carrying it resolves the
 * row. Filtering here conflated *can this event resolve the row* with *can this
 * event name the row*, which left every non-closing echo (an `act` scoped to a
 * session it does not end) with no candidates and a free-text box for a ULID —
 * the failure ADR 0005 exists to remove. Still derived rather than hardcoded, so
 * a couple's own type scoped to a couple's own span gets a picker for free.
 */
function timerMatches(rules: Rule[], typeId: string, key: string) {
	// Collapsed per timer/key rather than per rule, so `closes` is the OR over
	// every rule reaching that pair. Two rules closing one timer on one key from
	// different types is legal — the shipped pack has no such pair, but a couple
	// can write one — and as separate entries the non-closing sibling would answer
	// candidacy for rows the asking type really does discharge.
	const byPair = new Map<string, TimerMatch>();
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		for (const effect of rule.effects) {
			if (effect.verb !== "close_timer" || !effect.match_on) continue;
			for (const [timerKey, eventKey] of Object.entries(effect.match_on)) {
				if (eventKey !== key) continue;
				const closes = rule.condition.type === typeId;
				const pair = JSON.stringify([effect.timer, timerKey]);
				const prior = byPair.get(pair);
				if (prior) prior.closes ||= closes;
				else byPair.set(pair, { timer: effect.timer, timerKey, closes });
			}
		}
	}
	return [...byPair.values()];
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
 * `auto_closed` row was resolved, and *closing* it again means nothing.
 *
 * That last reasoning is about closing, and is false of an echo (#182). "We did
 * impact during last night's scene", logged the next morning, names a resolved
 * row and means everything — the act is not discharging the session, it is
 * saying which session it belongs to. So a non-closing echo may name a row at
 * any status; the caller bounds the list by recency instead
 * ({@link RECENT_ECHO_CANDIDATES}).
 */
function isCandidate(t: TimerView, now: number, closes: boolean): boolean {
	if (t.status === null) return true;
	if (!closes) return true;
	return (
		t.status === "expired" &&
		t.closed_at !== null &&
		t.closed_at >= now - EXPIRED_PROMPT_GRACE_MS
	);
}

/**
 * How many rows a *non-closing* echo offers. Bounded by count rather than by a
 * time window on purpose: a window can go empty on a quiet couple, and an empty
 * list silently degrades back to the free-text box this whole path exists to
 * remove. Ten covers logging an act the same day or the next; finding a session
 * from months ago is a search problem, and there is no data yet to justify one.
 */
export const RECENT_ECHO_CANDIDATES = 10;

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
	// A resolved row reaches a picker only as a non-closing echo (#182), and it
	// needs different words: how long it ran and how long ago, never how long
	// since it opened — a scene that ran an hour last night must not read "19h",
	// which is what the running-stopwatch phrasing below would say.
	if (t.status !== null) {
		const closedAt = t.closed_at ?? now;
		const ran = formatElapsed(closedAt - (t.opened_at ?? closedAt));
		return `${ran} · ${formatElapsed(now - closedAt)} ago`;
	}
	if (t.kind === "countdown") {
		const c = toCountdown(t);
		if (isCountdownExpired(c, now)) return "overdue";
		const left = `${formatRemaining(countdownRemainingMs(c, now))} left`;
		return t.paused_at != null ? `${left} (paused)` : left;
	}
	return formatElapsed(now - (t.opened_at ?? now));
}

/**
 * The timers an event of `typeId` could name through its `key` ref, as picker
 * options in the order the caller supplied them (the API's newest-first). Empty
 * when the ref originates its id, when no rule matches a timer on the key, or
 * when nothing qualifies — all three of which leave the field as free text.
 * What qualifies is {@link isCandidate}. One option per distinct id; ids sharing
 * a label (two stopwatches on the same activity) are disambiguated by the tail
 * of the id.
 *
 * Two flavors share this path (#182). A **closer** — an event whose own rule
 * discharges the timer — is offered only rows it could really discharge. A
 * **non-closing echo**, which names a row to pair with it, is offered rows at
 * any status, bounded to {@link RECENT_ECHO_CANDIDATES}.
 */
export function refCandidates({
	rules,
	timers,
	typeId,
	key,
	now,
	field,
	agreements = [],
}: {
	rules: Rule[];
	timers: TimerView[];
	typeId: string;
	key: string;
	now: number;
	/**
	 * The field being offered for. Required, not optional: a caller that omitted
	 * it would get an empty list for a citing ref and no indication why — the
	 * failure looks exactly like "this ref has no candidates", which is a normal
	 * answer here.
	 */
	field: MetadataField;
	/** The corpus a citing ref draws from (ADR 0006). Empty is a real answer. */
	agreements?: VersionedAgreement[];
}): RefCandidate[] {
	// A citing ref draws from the corpus rather than from open timers, and on the
	// opposite lifecycle: an Agreement is a candidate while it is in force, where
	// a timer stops being one the moment it resolves.
	if (isCitingRef(field)) {
		return citingCandidates(field, agreements, now);
	}
	// An originating ref is minted by the server and never client-supplied (ADR
	// 0005), so it can have no candidates by construction. Stated rather than
	// emergent: this used to fall out of the same-type filter in `timerMatches`
	// — nothing conditions on `session_started` to close the stopwatch it opens —
	// and dropping that filter (#182) took the accident with it.
	if (isOriginatingRef(field)) return [];

	const matches = timerMatches(rules, typeId, key);
	if (matches.length === 0) return [];

	// One row per distinct id, and specifically the *oldest* — a close resolves
	// oldest-open-wins (`matchStopwatch` reads rows ordered by `opened_at`), so a
	// label taken from any other row would describe a countdown the event is not
	// about to discharge. Minting (ADR 0005) means new rows can no longer share an
	// id at all; rows opened before it still can, so the tie-break stays.
	//
	// Candidacy is asked per timer/key pair rather than per row, because whether a
	// row qualifies now depends on whether *this* type closes it (#182) — and per
	// pair rather than per rule, so a second rule closing the same pair from
	// another type cannot answer for this one.
	const byValue = new Map<string, TimerView>();
	for (const t of timers) {
		for (const { timer, timerKey, closes } of matches) {
			if (t.timer !== timer) continue;
			if (!isCandidate(t, now, closes)) continue;
			const raw = t.match[timerKey];
			if (raw === undefined || raw === "") continue;
			const value = String(raw);
			const prior = byValue.get(value);
			if (prior && (prior.opened_at ?? 0) <= (t.opened_at ?? 0)) continue;
			byValue.set(value, t);
		}
	}

	// Bound a pure echo to the most recent rows. Insertion order follows the
	// caller's (newest-first), so the head is the most recent. A key that closes
	// anything at all keeps its full list — hiding a row the event could actually
	// discharge is the one failure worth avoiding, so the mixed case errs long.
	// Reads the same folded `closes` the loop above did, so the bound and candidacy
	// cannot disagree about which flavor this is.
	const rows = matches.every((m) => !m.closes)
		? [...byValue].slice(0, RECENT_ECHO_CANDIDATES)
		: [...byValue];

	// The tag is the human name where there is one (a stopwatch's activity);
	// otherwise the id itself is the name (a task countdown's `dishes`).
	const candidates = rows.map(([value, t]) => ({
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

/**
 * The Agreements a citing field may name, labelled by the name **in force now**
 * rather than the current one — the same reason a citation renders the old name:
 * what a term was called at the time is what the person agreed to.
 *
 * `agreement_kind` narrows the offer where the field says so. An `infraction`
 * names no kind because any term can be broken; `ritual_completed` names
 * `ritual`, so logging a completed ritual does not offer the couple's limits.
 */
function citingCandidates(
	field: MetadataField,
	agreements: VersionedAgreement[],
	now: number,
): RefCandidate[] {
	const wanted = field.kind === "ref" ? field.agreement_kind : undefined;
	const out: RefCandidate[] = [];
	for (const agreement of agreementsInForce(agreements, now)) {
		if (wanted !== undefined && agreement.kind !== wanted) continue;
		const version = agreementEffectiveAt(agreement, now);
		if (!version) continue;
		out.push({ value: agreement.id, label: version.name });
	}
	return out;
}
