/**
 * How wide a surface gets, and how much air sits around it, at every screen
 * size. One module, for the reason `fieldClass` is one module (#147): the
 * `mx-auto max-w-2xl p-6` that opened every screen was copy-pasted into
 * seventeen places, so the app had no width to change — it had seventeen, and
 * they could only ever be widened all at once by hand.
 *
 * The phone layout these carry is the one that was already there: a 2xl column
 * with 24px of padding. What is new is what happens above it. The app was built
 * phone-first and stopped there, so on a laptop every surface was a 672px strip
 * with several hundred pixels of empty gradient down each side.
 *
 * The fix is deliberately *not* "let the column grow". A line of prose at 1200px
 * is unreadable, so extra width is spent differently depending on what a surface
 * holds — which is why there are three of these and not one knob:
 *
 * - {@link pageClass} — prose. Agreements, onboarding, the vocabulary editor.
 *   The measure stays put; only the padding opens up. Desktop space is spent on
 *   margins here because that is what long text wants.
 * - {@link pageRowsClass} — surfaces that are a list of rows. The Log's stream,
 *   the rules table. A row is a timestamp, a name, and some metadata, so it has
 *   somewhere to put the width; 4xl is about as far as one goes before the eye
 *   loses the line.
 * - {@link pageColumnsClass} — surfaces that break into columns at `lg`. Today
 *   and Settings. Pair with {@link columnsClass} or a `grid`, never on its own:
 *   6xl of single column is the unreadable case above.
 *
 * `lg` (1024px) is the one breakpoint that matters here. It is the width at
 * which the tab bar becomes a side rail, so it is also the width at which a
 * surface stops being a phone screen and starts being a page.
 */

/** Shared by all three: centred, full-bleed under the cap, more padding at `lg`. */
const shell = "mx-auto w-full px-6 py-6 lg:px-8";

/** Prose surfaces. The measure is the point, so the column does not grow. */
export const pageClass = `${shell} max-w-2xl`;

/** Row surfaces — a wider row fits more per line without losing the line. */
export const pageRowsClass = `${shell} max-w-2xl lg:max-w-4xl`;

/**
 * Surfaces that lay out in columns at `lg`. Only ever paired with a
 * multi-column or grid child — see the note above about 6xl of running text.
 */
export const pageColumnsClass = `${shell} max-w-2xl lg:max-w-6xl`;

/**
 * The two-column flow itself, for a stack of independent panels.
 *
 * CSS multi-column rather than a grid, because the panels are ordered and the
 * order is argued for in the markup that uses it ("someone asking to talk
 * outranks a day count"). Multi-column keeps one flat DOM order and flows it
 * newspaper-style; a two-column grid would need the panels split into a main
 * list and a rail list, which reorders them on the phone — where the argument
 * was made and still holds. Panel heights are independent, so this is also the
 * only layout that packs them without a grid's row-height lockstep.
 *
 * `break-inside-avoid` is the load-bearing part, not a nicety: without it the
 * flow will happily cut a panel in half at the column boundary and leave the
 * back half heading the next column, bordered on three sides and captioned by
 * nothing. Every child is a self-contained card, so none of them may break.
 *
 * `mb-4` on every child rather than `space-y-4`: `space-y` hangs its margin off
 * `:not(:first-child)`, and in a multi-column flow "first" is the first in the
 * document, not the first in each column — so the top of column two would come
 * away with an indent nothing else has.
 */
export const columnsClass =
	"[&>*]:mb-4 [&>*]:break-inside-avoid lg:columns-2 lg:gap-4";
