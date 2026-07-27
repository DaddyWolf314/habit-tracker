import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { ackRuleChanges, listRuleChanges } from "#/lib/api.ts";
import {
	type RuleChangeNotice as Notice,
	ruleChangeNotice,
} from "#/shared/notifications.ts";

/**
 * "Since you last looked" — what your partner changed about the automation that
 * binds you (#64, #123).
 *
 * This is a consent mechanism, not a convenience. ADR 0002 gates rule authoring
 * to dom/switch and legitimises that with exactly this: "every change writes an
 * `audit_log` row and surfaces an in-app notice to the partner — transparency
 * standing in for a mutual-consent handshake, so dom-only authoring stays
 * consensual for the sub who is bound by rules they cannot author." It used to
 * live on the Rules screen, and #123 moved that screen into Settings — so the
 * notice moved *out* of it, to Today, rather than following the editor two taps
 * deep behind a gear icon where the bound party has no daily reason to look.
 *
 * Own component with its own fetch, because the editor and the notice now live
 * on different surfaces and neither should have to know about the other.
 */
export function RuleChangeNotice() {
	const [changes, setChanges] = useState<Notice[]>([]);

	useEffect(() => {
		let live = true;
		listRuleChanges()
			.then((res) => {
				if (live) setChanges(res.changes);
			})
			// Today is a glance surface: a failed fetch leaves the notice for the
			// next load rather than putting an error where the countdowns go. The
			// server keeps the changes unacknowledged, so nothing is lost.
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	const acknowledge = useCallback(async () => {
		try {
			await ackRuleChanges();
			setChanges([]);
		} catch {
			// A failed ack leaves the notices up: showing them again is the right
			// failure, marking a change seen that never reached the server is not.
		}
	}, []);

	if (changes.length === 0) return null;

	return (
		<section className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
			<p className="font-medium">Since you last looked</p>
			<ul className="space-y-1 text-muted-foreground">
				{changes.map((change) => (
					<li key={`${change.at}-${change.kind}-${change.rule_id}`}>
						{ruleChangeNotice(change)}
					</li>
				))}
			</ul>
			<Button size="xs" variant="outline" onClick={acknowledge}>
				Got it
			</Button>
		</section>
	);
}
