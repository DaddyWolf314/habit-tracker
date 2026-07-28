/**
 * Styling for a bare `<select>` — the one control the app still renders
 * natively rather than through a `ui/` component, because a native picker is
 * the better phone affordance and Radix's is not worth the trade here.
 *
 * It lived as an identical copy-pasted constant in eight screens until #147,
 * which is exactly the arrangement that lets a tap-target floor rot: raising it
 * meant finding all eight. One export, so the next height change is one edit.
 *
 * `h-11` is the same 44px floor `Button`'s `default` and `Input` sit at (#147)
 * — a field and the button beside it are the same height by construction, not
 * by coincidence, so a form row never lands visibly ragged.
 */
export const fieldClass =
	"h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";
