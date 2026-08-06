import { useEffect } from "react";
import { ackCrossings } from "#/lib/api.ts";
import {
	agreementEffectiveAt,
	latestAgreementVersion,
	type VersionedAgreement,
} from "#/shared/agreements.ts";
import { type Counter, rungsReached } from "#/shared/counters.ts";

/**
 * Where the couple's ladders stand (#193, ADR 0015) — a banner for every rung a
 * counter currently sits at or above, in the words of the term it cites.
 *
 * **Derived from the value, never from the crossing rows.** That is what makes it
 * clear by itself when the counter drops by reset, acknowledgment, decrement, or
 * a reversal (ADR 0016): the recorded crossing stays, because it happened, and
 * the banner goes, because the derived state is false. It is also why there is
 * nothing here to dismiss — a crossing is a recorded moment, not a debt, and an
 * item someone closes would assert an obligation the app cannot verify was
 * discharged (the reasoning that gave an act an empty `awaiting` in #182).
 *
 * **Rendered for both roles, identically.** Handoff §8's "no countdowns, no
 * anxiety mechanics" governs pressure the *app* invents — the queue shows the dom
 * a time-in-queue and shows the sub nothing of the kind — but a ladder is a term
 * the couple consented to, and concealing its state from the person it binds
 * would make the consent record asymmetric in the one direction it must never be.
 * So this panel takes no role and branches on none.
 *
 * The prose is the version in force **now**, not at the crossing: the banner says
 * what currently binds, while the crossing row on the counter's chain says what
 * was announced then (resolved at that event's `occurred_at`, ADR 0006).
 */
export function RungsPanel({
	counters,
	agreements,
}: {
	counters: Counter[];
	/** The corpus, for the term each rung cites (ADR 0006). */
	agreements: VersionedAgreement[];
}) {
	// Acknowledged on arrival, and deliberately not gated on a banner being here
	// to see. A crossing raises the count for both members (ADR 0015), and a
	// counter can fall back below its rung before either of them looks — a badge
	// that only cleared while a banner showed would then never clear at all. The
	// moment is still on the counter's chain, which is where a crossing is kept.
	useEffect(() => {
		ackCrossings().catch(() => {
			// A failed ack leaves the count up for the next load: showing it again is
			// the right failure; clearing one that never reached the server is not.
		});
	}, []);

	const now = Date.now();
	const standing = counters.flatMap((counter) =>
		rungsReached(counter.rungs, counter.value).map((rung) => ({
			counter,
			rung,
		})),
	);
	if (standing.length === 0) return null;

	return (
		<section className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-4">
			<h2 className="text-lg font-semibold">Where you stand</h2>
			<ul className="space-y-3">
				{standing.map(({ counter, rung }) => {
					const agreement = agreements.find((a) => a.id === rung.agreement_ref);
					// A term the couple no longer holds renders its ref rather than a
					// blank — the same call `describeCitation` makes, and for the same
					// reason: an opaque id is a better answer than nothing.
					const version = agreement
						? (agreementEffectiveAt(agreement, now) ??
							latestAgreementVersion(agreement))
						: null;
					return (
						<li key={`${counter.id}-${rung.at}`} className="text-sm">
							<p className="font-medium">
								{counter.name} is at {counter.value} — {rung.at} and above
							</p>
							<p className="mt-0.5 text-muted-foreground">
								{version?.name ?? rung.agreement_ref}
							</p>
							{version?.text && (
								<p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
									{version.text}
								</p>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
