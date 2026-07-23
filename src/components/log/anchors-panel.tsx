import type { AnchorView } from "#/shared/anchors.ts";
import { anchorLabel } from "#/templates/index.ts";
import { elapsedDaysText } from "./formatting.ts";

/**
 * Elapsed-since anchors panel (handoff §4.5, §9 today view; #78). Each anchor
 * reads as "days since …" at a glance; an anchor that has never been reset
 * shows "—", not "0 days". The two orgasm anchors are deliberately adjacent —
 * "since sub's last" beside "since dom's last" — because reading them together
 * *is* the "sub waits for the dom" Protocol's visibility surface (ADR 0003):
 * the mechanical layer supplies the evidence, the humans supply the judgment.
 */
export function AnchorsPanel({ anchors }: { anchors: AnchorView[] }) {
	if (anchors.length === 0) return null;
	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Clocks</h2>
			<ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
				{sortForDisplay(anchors).map((anchor) => (
					<li key={anchor.anchor} className="rounded-md bg-muted/40 px-3 py-2">
						<div className="text-xs text-muted-foreground">
							{anchorLabel(anchor.anchor)}
						</div>
						<div className="text-lg font-semibold">
							{elapsedDaysText(anchor.elapsed_days)}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

/**
 * Keeps the dom orgasm anchor immediately after the sub's so the pair reads
 * side by side; everything else stays in server order.
 */
function sortForDisplay(anchors: AnchorView[]): AnchorView[] {
	const dom = anchors.find((a) => a.anchor === "since_dom_last_orgasm");
	if (!dom) return anchors;
	const rest = anchors.filter((a) => a !== dom);
	const at = rest.findIndex((a) => a.anchor === "since_last_orgasm");
	if (at === -1) return anchors;
	return [...rest.slice(0, at + 1), dom, ...rest.slice(at + 1)];
}
