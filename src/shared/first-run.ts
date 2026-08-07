import { agreementEffectiveAt, type VersionedAgreement } from "./agreements.ts";
import type { Counter } from "./counters.ts";
import type { EventType } from "./event-types.ts";
import type { Rule } from "./rules.ts";
import { countingTypeFor, isTracked } from "./scaffold.ts";
import { targetRows } from "./target-rows.ts";

/**
 * What a couple who has not started yet should do next (#212).
 *
 * Today is **not blank** on a fresh install, which is what makes this worth
 * deriving rather than writing as a paragraph. The pack seeds
 * `rituals_completed_today` with `daily_target: 1`, so `targetRows` yields one
 * row from the first minute — and R1 increments it *unconditionally*
 * (`when ritual_completed → +1`, no metadata clause), which is exactly the case
 * `tickFor` refuses to offer a tick for, because an unconditional rule names
 * nothing a tick could cite. So the landing screen opens on a single counter the
 * couple never created, at 0/1, with no way to act on it.
 *
 * The chain out of that state is real and short, and each link is already
 * derivable, so the advice is computed instead of asserted:
 *
 *  - **write** — the corpus is empty. Nothing ships in it on purpose (a default
 *    term is one nobody consented to but everybody has), so there is genuinely
 *    nothing else to do first.
 *  - **track** — a ritual is written but nothing counts it. Tracking it is the
 *    step that mints a rule citing that term, which is what turns the dead
 *    readout above into a row with a tick.
 *  - **log** — everything is wired; the log is just empty.
 *
 * Deliberately says nothing about *whether* anything has been logged. That
 * question is viewer-dependent — `listEvents` omits a partner's `secret` entries
 * entirely (ADR 0001) — so a floor that told one partner "nothing has happened
 * yet" would be making a false claim about the couple's record to the person
 * least able to check it. The caller decides when to show this; the step itself
 * only ever describes what is *set up*, which both partners see alike.
 */
export type FirstRunStep = "write" | "track" | "log";

export function firstRunStep({
	agreements,
	counters,
	rules,
	types,
	now,
}: {
	agreements: VersionedAgreement[];
	counters: Counter[];
	rules: Rule[];
	types: EventType[];
	now: number;
}): FirstRunStep {
	// In force and not retired — the same slice a citing ref may offer. A retired
	// term stays readable but is not something to build a first step on.
	const live = agreements.filter((agreement) => {
		const version = agreementEffectiveAt(agreement, now);
		return version !== null && !version.retired;
	});
	if (live.length === 0) return "write";

	// Something already ticks, so the wiring is done and only the log is empty.
	// Read through `targetRows` rather than by scanning the rules, so this agrees
	// with the panel below it by construction — the two must not disagree about
	// whether there is anything to tick.
	const tickable = targetRows({ counters, rules, types }).some(
		(row) => row.tickLogs !== null,
	);
	if (tickable) return "log";

	// A term that *could* be counted and is not yet — through the very derivation
	// the Agreements screen offers "Track this" from, so the floor cannot point at
	// a term that screen would refuse to track.
	//
	// That parity is only safe since #213. `countingTypeFor` used to read a citing
	// ref declaring no `agreement_kind` as counting every kind, and the pack ships
	// one — `infraction.rule_ref`, unqualified because a breach may cite any term —
	// so it answered "track a limit?" with `infraction`. This carried a private
	// qualified-match predicate to stay clear of that; now the shared helper is
	// right, keeping a second copy would just be a second thing to keep in step.
	const trackable = live.some(
		(agreement) =>
			countingTypeFor(agreement.kind, types) !== null &&
			!isTracked(agreement.id, rules, types),
	);
	return trackable ? "track" : "log";
}
