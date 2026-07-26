import { Button } from "#/components/ui/button.tsx";

/**
 * The armed half of the house two-tap inline confirm (#93) — the "Yes, <verb>"
 * and "Cancel" pair a destructive control swaps itself for after its first tap.
 * A browser dialog is never used: it blocks the whole surface, and these taps
 * land in charged moments (see `pause-everything.tsx`).
 *
 * Only the armed half is shared. The resting trigger stays at the call site,
 * because what it reads and how loud it looks are local decisions — Reset is a
 * routine control until it is armed, Delete and Remove carry the tint from the
 * start — and so is where the armed flag lives: a per-row component holds a
 * boolean (`rules-view.tsx`), a list holds the id of the one armed row so it
 * can never arm two at once (`counters-panel.tsx`).
 */
export function InlineConfirm({
	label,
	size = "sm",
	busy = false,
	onConfirm,
	onCancel,
}: {
	/** The affirmative, in the house "Yes, <verb>" form. */
	label: string;
	size?: "xs" | "sm";
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<>
			<Button
				variant="destructive"
				size={size}
				disabled={busy}
				onClick={onConfirm}
			>
				{busy ? "…" : label}
			</Button>
			<Button variant="ghost" size={size} disabled={busy} onClick={onCancel}>
				Cancel
			</Button>
		</>
	);
}
