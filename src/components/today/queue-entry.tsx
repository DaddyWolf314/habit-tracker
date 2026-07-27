import { Link } from "@tanstack/react-router";

/**
 * "2 awaiting your ruling" — handoff §8.1's entry point to the queue, on the
 * screen it asks for (#136).
 *
 * Takes the count rather than deriving it: the number comes from `queueCount`,
 * which folds the log server-side. Holding the log on Today to derive one
 * integer is the shape #88 recorded as the reason an aggregate endpoint is
 * wanted, and it would be a poor trade for a screen that polls every 15s.
 *
 * There is deliberately **no sub-side counterpart**. §8.3 gives the sub a "quiet
 * 'awaiting ruling' chip" on their own log entries and says "no countdowns, no
 * anxiety mechanics"; a row on their home screen counting how many of their
 * confessions are still being judged is the thing that line declines. The chips
 * already exist in the event stream, and a sub's count is zero here because
 * nothing awaits *their* ruling.
 */
export function QueueEntry({ count }: { count: number }) {
	if (count === 0) return null;

	return (
		<Link
			to="/log"
			className="block rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm"
		>
			<span className="font-medium">
				{count === 1 ? "1 thing awaits" : `${count} things await`} your ruling
			</span>
			<span className="ml-2 text-muted-foreground">Open the queue →</span>
		</Link>
	);
}
