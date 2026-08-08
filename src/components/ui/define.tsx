import { Explainer } from "#/components/ui/explainer.tsx";
import { defineTerms, type TermId } from "#/shared/glossary.ts";

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
 */
export function Define({ terms }: { terms: readonly TermId[] }) {
	const entries = defineTerms(terms);
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
		</Explainer>
	);
}
