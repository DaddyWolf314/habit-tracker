import { agreementEffectiveAt, type VersionedAgreement } from "./agreements.ts";
import type { Counter } from "./counters.ts";
import type { EventType } from "./event-types.ts";
import { isCitingRef } from "./refs.ts";
import type { Rule } from "./rules.ts";
import { isTracked } from "./scaffold.ts";
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

	// A term that *could* be counted and is not yet.
	const trackable = live.some(
		(agreement) =>
			countsKind(agreement.kind, types) &&
			!isTracked(agreement.id, rules, types),
	);
	return trackable ? "track" : "log";
}

/**
 * Whether some event type is *about* counting this kind — a citing ref that
 * names the kind outright.
 *
 * Deliberately **not** {@link countingTypeFor}, which is what the Agreements
 * screen offers "Track this" from. That helper also matches a citing ref which
 * declares no `agreement_kind` at all, and the pack ships one: `infraction`'s
 * `rule_ref`, which is unqualified precisely because a breach may cite any term.
 * So it answers "track a limit?" with `infraction`, and the scaffold built from
 * that reads *a positive daily target of one infraction against your own limit,
 * with a streak* — see #213, which is a bug in that screen and not this one's to
 * fix.
 *
 * Requiring the qualified match keeps the floor's advice right on both sides of
 * that fix: a ref declaring `agreement_kind: "ritual"` is the statement "this
 * type counts rituals", which is the only thing worth pointing a first-run
 * suggestion at, while an unqualified ref means "cite anything" and is not a
 * tracking relationship at all. A couple whose only terms are limits and
 * safewords is therefore told to log, rather than sent looking for a control
 * that should not be there.
 */
function countsKind(kindId: string, types: EventType[]): boolean {
	return types.some((type) =>
		Object.values(type.metadata).some(
			(field) =>
				isCitingRef(field) &&
				field.kind === "ref" &&
				field.agreement_kind === kindId,
		),
	);
}
