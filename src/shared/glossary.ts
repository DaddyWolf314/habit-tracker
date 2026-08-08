/**
 * The app's words, said in the app (#212 item 4).
 *
 * `CONTEXT.md` is the ubiquitous language and it is developer-facing. The UI
 * surfaces counter, streak, rung, waiver, amendment, adjudication, response,
 * currency and price with no definition anywhere in the product, so a couple
 * meets each of them as a word that clearly means something specific and is
 * never told what.
 *
 * **Inline at first appearance, not a Help screen.** Both shapes were on the
 * table. A Help screen is cheap, complete and mostly unvisited — it answers the
 * question in the one place nobody is standing when they have it — and the whole
 * argument of #210 is that an explanation is worth most at the moment and place
 * the question arises. The objection to inline was that it needed a shared
 * disclosure primitive rather than #210's one-off; `Explainer` is that, so the
 * remaining cost is the definitions themselves, which is this file.
 *
 * **One definition, many placements.** The entries live here and nowhere else,
 * so a term cannot come to mean two things on two screens — the discipline
 * `CONTEXT.md` sets for *Auto-closed* ("one word across the sessions panel, the
 * closed-countdown rows, and the trace ledger"), applied to the words themselves.
 * Placement is the caller's: a surface attaches the terms it is *about*, at the
 * heading that owns them, rather than every screen re-explaining every word.
 *
 * **Shipped, never persisted** — the #210 rule. A definition is documentation
 * about the app, which the app already ships; storing it would put prose behind a
 * version and make a wording fix need a migration to reach anybody.
 *
 * **Deliberately not the Vocabulary screen.** That is the couple's own enum
 * options — "Your words", the ones they add — and this is the app's. Naming these
 * the same thing is the collision #212 flagged, and the reason nothing here is
 * called a vocabulary.
 *
 * **Every entry is checked against `CONTEXT.md`, not written from memory.** A
 * definition that contradicts the model is worse than none: it is confidently
 * wrong, in the reader's own words, at the moment they decided to trust it. The
 * first draft of this file shipped three such sentences and a review caught them
 * — "nothing sets a counter by hand", beside the `±1` buttons that do; *session*
 * defined as the accumulating span, which is the stopwatch the CONTEXT entry's
 * _Avoid_ names outright; and an adjudication and a waiver attributed to "a dom"
 * where both are settled per event type or per rule-authoring role, so a switch
 * couple read the wrong actor. When adding one, read the CONTEXT entry and its
 * `_Avoid_` clause first, and prefer a hedge to a crisp sentence you cannot
 * source.
 */

export interface GlossaryEntry {
	/** The word as the UI writes it, for the toggle that asks about it. */
	term: string;
	/**
	 * What it means, in the second person and without naming a mechanism the
	 * reader has no access to. Each says what the thing *is* and then the one fact
	 * about it that surprises people — which is usually a fact about what the app
	 * will not do with it.
	 */
	definition: string;
}

export const GLOSSARY = {
	counter: {
		term: "counter",
		definition:
			"A number the app keeps by folding your log. A rule usually moves it when you log something, and either of you can nudge one by hand — but a nudge is logged too, so the number stays the log's answer rather than a second record that could disagree with it.",
	},
	streak: {
		term: "streak",
		definition:
			"How many days or weeks in a row you met a counter's target. It belongs to that counter rather than standing on its own, and it is worked out when the day rolls over, not when you log.",
	},
	clock: {
		term: "clock",
		definition:
			"How long it's been since the last thing that reset it. A clock counts since something; a countdown counts toward something. Nothing here is set by hand — a clock resets when one of your rules sees a matching event in the log.",
	},
	rung: {
		term: "rung",
		definition:
			"A number on one of your counters with one of your agreements attached to it. Passing it is a moment the log records, not a debt: nobody owes anything, and it clears itself when the counter drops back under.",
	},
	timer: {
		term: "timer",
		definition:
			"A stretch of time the app keeps for you: a countdown, which runs toward a deadline, or a stopwatch, which adds up while it is open. Rules open and close them, and a rule can also ask what was running when something was logged.",
	},
	countdown: {
		term: "countdown",
		definition:
			"A deadline. A rule opens one when something is logged, and it ends when it is completed, cancelled, or the time runs out. A dom can pause or extend one; pausing freezes the clock rather than ending it.",
	},
	session: {
		term: "session",
		definition:
			"A pair of logged events, one opening and one closing, that bounds a stretch of time. The row here is that stretch; anything you log in between belongs to it, which is what lets a rule score an act by the mode you were in.",
	},
	amendment: {
		term: "amendment",
		definition:
			"Anything added to an event after the fact — a ruling, a note, a retraction, a response, a waiver. Nothing in the log is ever edited or deleted, so a correction is always something appended beside what was said first.",
	},
	adjudication: {
		term: "adjudication",
		definition:
			"A ruling on something logged. Which of you rules is set per kind of event, and it is the one amendment that changes what the event is taken to say — everything else sits beside the event and leaves it alone.",
	},
	response: {
		term: "response",
		definition:
			"Something you write back to your partner's entry. A gift rather than a debt — nothing marks one owed, nothing counts how many went unanswered, and nothing chases either of you for one.",
	},
	waiver: {
		term: "waiver",
		definition:
			"Setting aside one of a rule's effects — suppressed before it lands, or reversed after. Whoever may write a rule may overrule it. The rule still fired and the log still says so: a waiver is a fact about the ruling, not a claim that nothing matched.",
	},
	currency: {
		term: "currency",
		definition:
			"A counter your rewards are priced in. Nothing marks a counter as one — it is whichever counter a price is measured against, and you can have as many as you have made.",
	},
	price: {
		term: "price",
		definition:
			"What a reward costs, in its currency. It is stamped onto the redemption as it happens, so repricing something later never changes what you already spent on it.",
	},
} as const satisfies Record<string, GlossaryEntry>;

/** The words this file defines — the ids a surface names to attach one. */
export type TermId = keyof typeof GLOSSARY;

/**
 * The entries for `ids`, in the order asked for.
 *
 * Order is the caller's because it is a reading order: a surface introducing
 * both a counter and a streak wants the counter first, since the second sentence
 * is only meaningful after the first.
 */
export function defineTerms(ids: readonly TermId[]): GlossaryEntry[] {
	return ids.map((id) => GLOSSARY[id]);
}
