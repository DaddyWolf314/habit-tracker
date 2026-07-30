/**
 * A small status chip — "default", "edited", "new default", "off".
 *
 * Lifted out of `rules-view.tsx` when the agreements screen needed the same
 * "new default" chip for an adopted kind (#159). Shared rather than copied for the
 * reason CLAUDE.md gives about `fieldClass`: the duplicate is how the styling
 * drifts, and a chip that means the same thing on two screens has to look the
 * same on both.
 *
 * Not a tap target — a badge is a readout, never interactive, so the #147 `h-11`
 * floor does not apply. If one ever needs to be tappable it becomes a `Button`
 * with a badge-like variant, not a badge with a click handler.
 */
export function Badge({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone: "neutral" | "accent" | "muted";
}) {
	const cls =
		tone === "accent"
			? "bg-primary/10 text-primary"
			: tone === "muted"
				? "bg-muted text-muted-foreground"
				: "bg-secondary text-secondary-foreground";
	return (
		<span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
			{children}
		</span>
	);
}
