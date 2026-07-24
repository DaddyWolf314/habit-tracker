import { useEffect } from "react";

/**
 * The shared live-refresh cadence. Every surface that polls uses this so the
 * "same cadence as Today" the tickets ask for is one number, not three literals
 * that can drift apart (#92).
 */
export const LIVE_REFRESH_MS = 15_000;

/**
 * Keep a surface live without a WebSocket push (the architecture plans one,
 * handoff §3.2, but the cheap fix doesn't wait on it): re-run `refresh` on a
 * low-frequency poll and whenever the tab returns to the foreground (window
 * focus or a visibility change), so a partner's new event or an incoming ruling
 * appears without a manual reload (#92).
 *
 * Errors are swallowed on purpose — a transient poll blip must stay quiet, and
 * the surfaces that use this already surface their first-load and post-mutation
 * failures through their own paths. Pass `enabled: false` before identity exists
 * so nothing polls against a space this device can't read.
 */
export function useLiveRefresh(
	refresh: () => Promise<void>,
	{ intervalMs, enabled = true }: { intervalMs: number; enabled?: boolean },
) {
	useEffect(() => {
		if (!enabled) return;

		const tick = () => {
			refresh().catch(() => {});
		};
		const onVisible = () => {
			if (document.visibilityState === "visible") tick();
		};

		const id = setInterval(tick, intervalMs);
		window.addEventListener("focus", tick);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(id);
			window.removeEventListener("focus", tick);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [refresh, intervalMs, enabled]);
}
