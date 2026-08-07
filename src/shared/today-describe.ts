import type { AnchorView } from "./anchors.ts";
import type { Counter, CounterRung } from "./counters.ts";
import { rewardItemEffectiveAt, type VersionedRewardItem } from "./rewards.ts";
import type { TargetRow } from "./target-rows.ts";

/**
 * What each of Today's panels is showing you *now*, and why (#212 item 2).
 *
 * Today's headings are four domain words the app never defines — **Clocks**,
 * **Where you stand**, **Within reach**, and, until this change, a panel headed
 * **Today** inside the page titled Today. #210 answered the same question on the
 * Agreements screen, and its answer came in two halves with different owners.
 * That split is what is repeated here: *what a panel is* is editorial copy about
 * the app and sits beside the markup it describes, while *what it is showing
 * you right now* is derived, and lives in this module.
 *
 * The derived half is the one that has to be a function, for the reason #210's
 * authorship line had to be: a shipped sentence would be asserting something
 * about the couple's own counters that it cannot see. It is also the half a
 * reader actually wants. Every panel on this screen renders only when it has
 * something, so nobody meets one empty — the question is never "what is a rung"
 * on its own, it is "why is *this* one here, and what makes it go away".
 *
 * Each function takes exactly what its panel **renders**, not the inputs the
 * panel derived that from, so a note and the rows under it cannot end up
 * describing different states. And each is called only from a panel that has
 * already refused to render empty, so none of them has a "nothing here" case to
 * phrase: that sentence is the panel's own `null`.
 *
 * Pure and dependency-free, like `rule-describe.ts` — the pattern #212 item 6
 * points at as the best explanatory affordance the app already has: mechanism
 * made legible, isomorphic, and testable without a DOM.
 */

/**
 * The clocks panel — one "days since" per anchor.
 *
 * The single confusing readout is the dash. An anchor nothing has ever reset
 * shows "—" rather than 0 (`anchorElapsedDays` returns null: there is no moment
 * to count from), and at a glance a dash and a zero are close enough to be read
 * as "it happened today" — the exact opposite of what it means. So the note
 * counts the dashes rather than restating the panel.
 *
 * Counted off `elapsed_days` and not `since`, because `elapsedDaysText` is what
 * puts the dash on screen and it reads `elapsed_days`. The two are equivalent on
 * real data — a null `since` yields a null count — so this is not a bug fix; it
 * is the note counting the field it is describing, so no future divergence can
 * leave it claiming a dash the panel isn't showing.
 */
export function describeClocks(anchors: readonly AnchorView[]): string {
	const unset = anchors.filter((anchor) => anchor.elapsed_days === null).length;
	if (unset === 0)
		return "Each of these is counting from something already in your log.";
	if (unset === anchors.length)
		return unset === 1
			? "Nothing has reset this one yet, so it reads “—” rather than 0."
			: "Nothing has reset any of these yet, so they all read “—” rather than 0.";
	return unset === 1
		? "One of these has never been reset, so it reads “—” rather than 0."
		: `${unset} of these have never been reset, so they read “—” rather than 0.`;
}

/**
 * The ladder banner — every rung a counter currently sits at or above.
 *
 * What a reader needs and the rows do not say is how this **goes away**.
 * CONTEXT §Crossing makes a crossing "a recorded moment, not a debt": there is
 * nothing here to dismiss, and the banner clears itself because it is derived
 * from the counter's value rather than from the recorded crossings. Someone who
 * cannot see that reads a standing banner as an outstanding item, which is the
 * one thing it is defined not to be.
 *
 * Naming the number it has to drop below is the derived part, and it is only
 * nameable while there is exactly one — with several, each row already carries
 * its own number and the sentence would be reciting them.
 */
export function describeLadders(
	standing: readonly { counter: Counter; rung: CounterRung }[],
): string {
	const only = standing.length === 1 ? standing[0] : null;
	if (only)
		return `${only.counter.name} is at ${only.counter.value}, and this rung starts at ${only.rung.at}. It clears itself if that drops back under ${only.rung.at} — there's nothing here to dismiss.`;
	return "Each of these clears itself when its counter drops back under the rung — there's nothing here to dismiss.";
}

/**
 * The store panel — the items the couple's currencies already cover.
 *
 * A price is measured against a **counter**, and which counter is the fact the
 * panel withholds: it lists names and prices, so a couple who minted a second
 * currency (ADR 0015 makes each score its own counter, so that is the normal
 * case, not an exotic one) cannot tell which number put an item here or what
 * would take it away. Naming the currency and what it stands at is also the
 * whole answer to "where did that go?" the next time the panel empties.
 */
export function describeWithinReach(
	within: readonly VersionedRewardItem[],
	counters: readonly Counter[],
	atMs: number,
): string {
	const byId = new Map(counters.map((counter) => [counter.id, counter]));
	// Keyed by id and not pushed, so two items priced in the same currency name it
	// once. Insertion order is the panel's order, so the sentence reads down the
	// list the reader is looking at.
	const currencies = new Map<string, Counter>();
	for (const item of within) {
		const version = rewardItemEffectiveAt(item, atMs);
		if (!version) continue;
		const counter = byId.get(version.currency);
		if (counter) currencies.set(counter.id, counter);
	}

	const named = [...currencies.values()];
	// A price in a counter the couple no longer holds still renders a row —
	// `affordableItems` reads a missing currency as 0, so this is reachable only
	// where the price is 0 too. Nothing honest left to name, so the note falls
	// back to the part that is true either way.
	if (named.length === 0)
		return "These are covered by what you have saved up now, and drop off again as you spend it.";

	const list = named
		.map((counter) => `${counter.name} at ${counter.value}`)
		.join(", ");
	return `Covered by ${list} as ${named.length === 1 ? "it stands" : "they stand"} now — spend back under a price and it drops off this list again.`;
}

/**
 * The targets panel — the counters carrying a target, and the tick on each.
 *
 * This one exists for a specific row. `tickFor` refuses to build a tick from a
 * rule that names nothing a tick could cite, and the pack's seeded
 * `rituals_completed_today` is exactly that case — R1 increments it
 * unconditionally — so the first row a new couple ever sees is a readout with no
 * button and nothing saying why (#212, #214). #214 covers that couple only while
 * their log is empty; the row outlives the floor.
 *
 * The three ways `tickFor` returns null — nothing increments the counter, the
 * rule is unconditional, two enabled rules cite different terms — are one
 * sentence from the reader's side, because all three are the same fact about
 * their rules: the rules do not pin down what this counter counts. Deliberately
 * not three sentences behind a reason code: the distinctions are about rule
 * shape, the fix is the same in every case, and a row that reads "two of your
 * rules disagree" sends someone hunting for a conflict the app should be naming
 * on the rules screen instead.
 */
/**
 * Where a target row came from, or null when nothing says (#212 item 5).
 *
 * "Track this" mints a counter, a streak and a rule, and the confirm sheet
 * explains all three *once*. After that the artifacts sit on Today and Rules with
 * nothing tying them to the term, so a couple who has forgotten reads three
 * things that appeared from nowhere. ADR 0006 stores no link back — the citing
 * rule is the record — so this is read out of the rules, the same direction
 * `isTracked` already reads them in reverse.
 *
 * Names the term even when the counter already carries its wording, which is the
 * common case because that is how `scaffoldPlan` names it. The repetition is the
 * point rather than a cost: what the reader lacks is not the word, it is that
 * this row is *downstream of an agreement* — and the two names drift the moment
 * either is renamed, at which point saying both is the only way to keep the row
 * findable in the corpus.
 */
export function describeTracking(
	row: TargetRow,
	termNames: Readonly<Record<string, string>>,
): string | null {
	if (row.tracks === null) return null;
	const name = termNames[row.tracks];
	// A term the couple no longer holds, or one not loaded yet: the relationship
	// is still true and still worth saying, so the sentence drops the name rather
	// than the fact — and never falls back to the id, which on a glance screen
	// beside a real name would read as a second, broken term.
	return name === undefined
		? "Counts one of your agreements, each time it's logged."
		: `Counts “${name}” from your agreements, each time it's logged.`;
}

export function describeTargets(rows: readonly TargetRow[]): string {
	const readouts = rows.filter((row) => row.tickLogs === null);
	if (readouts.length === 0)
		return "Every row here has a button, because your rules say exactly what each one counts.";

	// Named while naming is short, counted once it stops being. Two names is the
	// most a sentence carries before it turns into the list the panel already is.
	const subject =
		readouts.length <= 2
			? readouts.map((row) => `“${row.counter.name}”`).join(" and ")
			: `${readouts.length} of these`;
	const many = readouts.length > 1;
	return `${subject} ${many ? "have" : "has"} no button: nothing in your rules says exactly what ${many ? "they count" : "it counts"}, so ${many ? "they can only be readouts" : "it can only be a readout"}.`;
}
