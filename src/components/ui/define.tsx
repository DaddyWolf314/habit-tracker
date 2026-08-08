import type { ReactNode } from "react";
import { Explainer } from "#/components/ui/explainer.tsx";
import { GLOSSARY, type TermId } from "#/shared/glossary.ts";

/**
 * The app's own words, defined where they are used (#212 item 4).
 *
 * One {@link Explainer} carrying one or more entries from the glossary, attached
 * to the heading that *owns* the terms rather than to every mention of them. A
 * toggle beside every occurrence of "counter" would be noise on a screen that
 * says it nine times; the section that is about counters is the place where the
 * question is actually being asked, and it is where item 2 already put the same
 * affordance for Today's panels.
 *
 * Several terms behind one toggle rather than one each, for the same reason:
 * they are asked together. Someone meeting "streak" is a line away from meeting
 * "counter", and two toggles side by side make the reader choose which word they
 * are confused about before finding out.
 *
 * The label asks the reader's question in their words — "What's a counter?" for
 * one, and a plain "What do these words mean?" for several, because the
 * alternative is a list read out as a question ("What's a counter, a streak or a
 * rung?"), which is longer than the answer.
 *
 * `children` is the **derived** half, and it is what lets a panel with its own
 * computed sentence still get its word from here. Today's clocks and ladder
 * panels used to read `GLOSSARY.x.definition` and render it as a bare `<p>`
 * beside their derived line, precisely because this component had nowhere to put
 * that line — which left the same data with two presentations, and left those two
 * words as the only ones whose term never appeared beside its definition. The
 * slot is cheaper than the divergence.
 *
 * Terms are read in the order given: it is a reading order, not a set, since
 * "streak" only means anything after "counter".
 */
export function Define({
	terms,
	children,
}: {
	terms: readonly TermId[];
	/**
	 * Anything the surface has to add that the glossary cannot know — a sentence
	 * derived from what the panel is currently showing, or one fact about *this*
	 * panel. Rendered after the definitions, since it is only meaningful once the
	 * word is.
	 */
	children?: ReactNode;
}) {
	const entries = terms.map((id) => GLOSSARY[id]);
	if (entries.length === 0) return null;

	return (
		<Explainer
			label={
				entries.length === 1
					? `What's a ${entries[0].term}?`
					: "What do these words mean?"
			}
		>
			{/*
			 * A description list, not paragraphs: the term is the thing being looked
			 * up, so it has to be findable by eye rather than buried in the first
			 * clause of its own definition. With one entry the term still leads —
			 * the toggle asked the question, and repeating the word is what makes the
			 * answer read as an answer to it.
			 */}
			<dl className="space-y-1">
				{entries.map((entry) => (
					<div key={entry.term}>
						<dt className="inline font-medium text-foreground">{entry.term}</dt>
						{/* The dash is punctuation for the eye only: `dt`/`dd` already say
						    which is the term and which the definition, so a screen reader
						    reading "dash" between them adds nothing. Keeping it out of the
						    `dd`'s own text also leaves the definition the exact string the
						    glossary holds, rather than that string with a prefix. */}
						<dd className="inline">
							<span aria-hidden="true"> — </span>
							{entry.definition}
						</dd>
					</div>
				))}
			</dl>
			{children}
		</Explainer>
	);
}
