import { Link } from "@tanstack/react-router";
import { CalendarDays, ScrollText, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getNotifications } from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import { LIVE_REFRESH_MS, useLiveRefresh } from "#/lib/use-live-refresh.ts";
import { useSession } from "#/lib/use-session.ts";

const TABS = [
	{ to: "/today", label: "Today", Icon: CalendarDays },
	{ to: "/log", label: "Log", Icon: ScrollText },
	{ to: "/settings", label: "Settings", Icon: Settings },
] as const;

/**
 * How tall the bar stands in flow, and the offset anything floating over a
 * surface needs to clear it by. Exported as one pair because the bar's height
 * and the Log's compose button are the same measurement seen from two files: a
 * bar that grows on its own silently covers the button (cf. `LIVE_REFRESH_MS` —
 * "one number, not three literals that can drift apart", #92).
 */
export const TAB_BAR_SPACER = "h-20";
export const ABOVE_TAB_BAR = "bottom-24";

/**
 * The app's navigation (#85, handoff §9). Every surface used to be a spoke off
 * `/` reachable only by a text "Back" link, so the dom's daily loop — check the
 * queue, check the countdowns, rule — crossed the hub on every hop. These are
 * the surfaces of a normal day once the dynamic is live; anything rarer (the
 * rule editor, devices, the recovery phrase) hangs off Settings. Rules held a
 * tab until #123 and lost it to that same test: nobody edits R12 on a Tuesday.
 *
 * Mounted from the root layout beside the pause-everything bar, and gated on
 * `roles_active`: before both partners confirm, `/` *is* the app and there is
 * nowhere else to go, so tabs would only offer dead ends. A dissolved couple
 * keeps the tabs — the log is theirs to read until they delete it — even though
 * `/` sends them to Settings instead, where the frozen notice and the export
 * are; the redirect answers "where does this open", the bar "what can I reach".
 */
export function TabBar() {
	const { session } = useSession();
	const active = session?.roles_active === true;
	const unread = useUnreadCount(active);

	if (!active) return null;
	return <TabBarNav unread={unread} />;
}

/**
 * The bar itself, split from its data so the navigation contract is testable
 * without standing up a session. Fixed to the bottom for thumb reach, with an
 * in-flow spacer so the last of a scrolled surface never hides underneath it.
 */
export function TabBarNav({ unread = 0 }: { unread?: number }) {
	return (
		<>
			<div aria-hidden="true" className={TAB_BAR_SPACER} />
			<nav
				aria-label="Main"
				className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
			>
				<ul className="mx-auto flex max-w-2xl">
					{TABS.map(({ to, label, Icon }) => (
						<li key={to} className="flex-1">
							{/* The colours carry `!` because `styles.css` paints every anchor
							    the link teal from an unlayered rule, which would otherwise
							    flatten the active tab into the other three — and they are split
							    across active/inactive rather than overridden, since two
							    `!important` utilities on one element resolve by source order,
							    not by which one the router meant to win. */}
							<Link
								to={to}
								className="relative flex min-h-14 flex-col items-center justify-center gap-1 py-2 text-xs transition-colors"
								activeProps={{
									className: "text-foreground! font-medium",
									"aria-current": "page",
								}}
								inactiveProps={{
									className: "text-muted-foreground! hover:text-foreground!",
								}}
							>
								{({ isActive }) => (
									<>
										{isActive && (
											<span
												aria-hidden="true"
												className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-current"
											/>
										)}
										<Icon aria-hidden="true" className="size-5" />
										{label}
										{to === "/log" && unread > 0 && (
											<span className="absolute top-1 left-1/2 ml-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground">
												<span aria-hidden="true">{unread}</span>
												{/* Content-free (#42): the count, never what the
												    items are. The comma keeps the tab's accessible
												    name from running together as "Log3". */}
												<span className="sr-only">
													, {unread} new item{unread === 1 ? "" : "s"}
												</span>
											</span>
										)}
									</>
								)}
							</Link>
						</li>
					))}
				</ul>
			</nav>
		</>
	);
}

/**
 * The unread count that used to sit on the old home page. Tabs took that page
 * out of the daily loop, so the badge moved onto Log — the one place those new
 * items (a partner's event, an incoming ruling) actually land — and now follows
 * the couple across every surface instead of waiting on the hub.
 */
function useUnreadCount(enabled: boolean) {
	const [unread, setUnread] = useState(0);

	const refresh = useCallback(async () => {
		setUnread((await getNotifications()).unread);
	}, []);

	useEffect(() => {
		if (!enabled) return;
		refresh().catch(() => setUnread(0));
	}, [enabled, refresh]);

	useLiveRefresh(refresh, {
		intervalMs: LIVE_REFRESH_MS,
		enabled: enabled && hasIdentity(),
	});

	return unread;
}
