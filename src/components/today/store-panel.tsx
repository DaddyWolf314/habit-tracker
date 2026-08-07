import { Link } from "@tanstack/react-router";
import type { Counter } from "#/shared/counters.ts";
import {
	affordableItems,
	rewardItemEffectiveAt,
	type VersionedRewardItem,
} from "#/shared/rewards.ts";

/**
 * What the store has within reach (#194, ADR 0017) — Today's entrance to the
 * rewards screen, and the one line a person actually wants from a catalogue on a
 * phone: *can I have something*.
 *
 * It is the state half of the affordability signal, standing in the same relation
 * to a **price crossing** that {@link RungsPanel} stands in to a rung crossing:
 * the crossing is the recorded moment on the counter's chain, this is the derived
 * state, and it clears by itself when the currency drops — because it is computed
 * from the currency's value rather than from the rows.
 *
 * **Both partners, identically**, for the reason the ladder is: a price is a term
 * the couple agreed, and the person saving toward it is the last one to hide it
 * from. There is deliberately no ack here — the store screen owns that, the way
 * the Agreements screen owns the corpus one — so landing on Today never dismisses
 * news that a price moved.
 *
 * Silent when nothing is affordable, rather than showing a "0 within reach" row:
 * a couple with a store and nothing banked yet gets the panel out of the way, and the
 * distance to each price is on the store screen, where the item it belongs to is.
 */
export function StorePanel({
	items,
	counters,
}: {
	items: VersionedRewardItem[];
	/** The currencies, for the value each price is measured against. */
	counters: Counter[];
}) {
	const now = Date.now();
	// The shared fold, so this panel and the store screen can never disagree about
	// what "within reach" means.
	const within = affordableItems(items, counters, now);
	if (within.length === 0) return null;

	return (
		<section className="rounded-md border p-4">
			<h2 className="font-medium">Within reach</h2>
			<ul className="mt-2 space-y-1 text-sm">
				{within.map((item) => {
					const version = rewardItemEffectiveAt(item, now);
					if (!version) return null;
					return (
						<li key={item.id} className="text-muted-foreground">
							{version.name} — {version.price}
						</li>
					);
				})}
			</ul>
			<p className="mt-3 text-sm">
				<Link to="/rewards" className="underline">
					Open the rewards
				</Link>
			</p>
		</section>
	);
}
