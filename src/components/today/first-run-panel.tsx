import { Link } from "@tanstack/react-router";
import type { FirstRunStep } from "#/shared/first-run.ts";

/**
 * The first-run floor on Today (#212).
 *
 * Today looked like it had a floor already, because every panel returns null
 * when empty — but the pack seeds a counter with a daily target, so what a new
 * couple actually lands on is one row reading "Rituals completed today 0/1",
 * under a heading that repeats the page title, with no tick on it (R1 is
 * unconditional, so `tickAndTerm` has nothing to cite). A seeded number nobody
 * asked for is a worse first impression than an empty page: it looks like the
 * app is already tracking something about you.
 *
 * So this does not say "you have nothing" — it says what the next move is, and
 * it accounts for the row underneath rather than leaving it unexplained.
 *
 * It used to open by saying what the screen *is* as well. That moved to the
 * page's lead sentence (#212 item 3): it is true whether or not the couple has
 * started, and this floor is keyed on an empty log, so the one line every
 * visitor needs was the one that disappeared first.
 *
 * **It asserts nothing about what has been logged.** The caller shows this while
 * the viewer can see no events, and that is viewer-dependent — `listEvents`
 * omits a partner's `secret` entries entirely (ADR 0001). Copy reading "nothing
 * has happened yet" would therefore be a false claim about the couple's record,
 * shown to the partner least able to check it. Everything here is either about
 * the app or about what is *set up*, which both partners see alike; the worst a
 * mistimed render can do is tell someone something they already know.
 */
export function FirstRunPanel({ step }: { step: FirstRunStep }) {
	return (
		<section className="rounded-lg border border-dashed p-4">
			<h2 className="font-medium">Getting started</h2>
			{/*
			 * What Today *is* used to be the paragraph here, because the page had no
			 * lead sentence and this was the only place to say it. #212 item 3 gave
			 * the page one ("Rules, Rewards, Vocabulary and Settings each open with
			 * one; Log and Today do not"), so the sentence moved there — it is a fact
			 * about the screen, not about being new, and a floor that disappears is
			 * the wrong home for it.
			 *
			 * What is left is only what this panel is actually for: the next move, and
			 * the seeded row that would otherwise look like the app tracking something
			 * about you.
			 */}
			<div className="mt-2 text-sm">{STEP_COPY[step]}</div>
			<p className="mt-3 text-xs text-muted-foreground">
				The counter below ships with the app so there's something for the rules
				to fold into. It starts moving once a ritual is logged.
			</p>
		</section>
	);
}

/**
 * One block per step. Held as a map rather than branching in the body so the
 * three read side by side — they are alternatives to each other, and the thing
 * most likely to go wrong is one of them drifting out of the voice of the other
 * two.
 */
const STEP_COPY: Record<FirstRunStep, React.ReactNode> = {
	write: (
		<>
			<p className="font-medium">Start with something you've agreed.</p>
			<p className="mt-1 text-muted-foreground">
				Nothing ships in{" "}
				<Link to="/agreements" className="underline">
					Agreements
				</Link>{" "}
				on purpose — a default term is one nobody consented to but everybody
				has. A ritual, a protocol, a limit, a safeword: whatever you've actually
				settled between you.
			</p>
		</>
	),
	track: (
		<>
			<p className="font-medium">Track one of your rituals.</p>
			<p className="mt-1 text-muted-foreground">
				Open it in{" "}
				<Link to="/agreements" className="underline">
					Agreements
				</Link>{" "}
				and choose <strong>Track this</strong>. That's what gives it a daily
				target and a streak here, with something to tick off.
			</p>
		</>
	),
	log: (
		<>
			<p className="font-medium">Log the first one.</p>
			<p className="mt-1 text-muted-foreground">
				Everything on this screen is folded from{" "}
				<Link to="/log" className="underline">
					the log
				</Link>
				, so it stays quiet until there's something in it.
			</p>
		</>
	),
};
