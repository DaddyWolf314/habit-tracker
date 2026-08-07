import { Link } from "@tanstack/react-router";
import type { FirstRunStep } from "#/shared/first-run.ts";

/**
 * The first-run floor on Today (#212).
 *
 * Today looked like it had a floor already, because every panel returns null
 * when empty — but the pack seeds a counter with a daily target, so what a new
 * couple actually lands on is one row reading "Rituals completed today 0/1",
 * under a heading that repeats the page title, with no tick on it (R1 is
 * unconditional, so `tickFor` has nothing to cite). A seeded number nobody asked
 * for is a worse first impression than an empty page: it looks like the app is
 * already tracking something about you.
 *
 * So this does not say "you have nothing" — it says what the screen is and what
 * the next move is, and it accounts for the row underneath rather than leaving
 * it unexplained.
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
			<p className="mt-2 text-sm text-muted-foreground">
				Today is the day's slice — what you're aiming at, what's running, and
				anything waiting on one of you. It fills in as you use the app, so most
				of it is hidden until there's something to show.
			</p>
			<div className="mt-3 text-sm">{STEP_COPY[step]}</div>
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
