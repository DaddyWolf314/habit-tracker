import { Button } from "#/components/ui/button.tsx";

/**
 * The armed half of the house two-tap inline confirm (#93) — the "Yes, <verb>"
 * and "Cancel" pair a destructive control swaps itself for after its first tap.
 * A browser dialog is never used: it blocks the whole surface, and these taps
 * land in charged moments (see `pause-everything.tsx`).
 *
 * Every guarded action in the app arms through this: dissolve
 * (`settings-view.tsx`), resume (`pause-everything.tsx`), retraction
 * (`event-stream.tsx`), rule removal (`rules-view.tsx`), and counter reset and
 * delete (`counters-panel.tsx`).
 *
 * Only the armed half is shared. The resting trigger stays at the call site,
 * because what it reads and how loud it looks are local decisions — Reset is a
 * routine control until it is armed, Delete and Remove carry the tint from the
 * start — and so is where the armed flag lives: some hold a boolean, one holds
 * a third mode beside an unrelated form, and a list holds the id of the one
 * armed row so it can never arm two at once.
 */
export function InlineConfirm({
	label,
	cancelLabel = "Cancel",
	tone = "destructive",
	size = "sm",
	busy = false,
	onConfirm,
	onCancel,
}: {
	/** The affirmative, in the house "Yes, <verb>" form. */
	label: string;
	/**
	 * Overrides the negative's wording where declining has its own meaning:
	 * resume's is "Stay paused", which names what you are choosing, not just
	 * what you are backing out of.
	 */
	cancelLabel?: string;
	/**
	 * `neutral` for a guarded action that isn't destructive — resume restarts
	 * every clock at once, which earns the second tap but not the red.
	 */
	tone?: "destructive" | "neutral";
	size?: "xs" | "sm";
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<>
			<Button
				variant={tone === "destructive" ? "destructive" : "default"}
				size={size}
				disabled={busy}
				onClick={onConfirm}
			>
				{busy ? "…" : label}
			</Button>
			<Button variant="ghost" size={size} disabled={busy} onClick={onCancel}>
				{cancelLabel}
			</Button>
		</>
	);
}
