import { useEffect, useState } from "react";
import {
	AUTO_LOCK_OFF,
	applyLockBroadcast,
	getAutoLockMinutes,
	isLocked,
	isPinSet,
	lockIfAwayTooLong,
	markAway,
	subscribeLock,
} from "./pin.ts";

/**
 * This device's PIN-lock state, live (#42, #97). Two things make it a hook
 * rather than three calls into `lib/pin.ts`:
 *
 * - The lock now changes while the app is open — someone locks deliberately, or
 *   comes back from too long away — so anything that renders off it has to
 *   subscribe, not read once on mount.
 * - The state lives in browser storage, which the server render can't see. It
 *   reads `false` everywhere until `ready`, so the markup the client hydrates
 *   matches what the server sent and locked content never flashes on load.
 *
 * `useSyncExternalStore` would be the shorter spelling, but its server snapshot
 * is one value for the whole render rather than the "not read yet" flag the
 * hydration needs, which is what `ready` carries.
 */
export function usePinLock(): {
	/** False until the first client-side read; nothing below it is meaningful yet. */
	ready: boolean;
	locked: boolean;
	pinSet: boolean;
	/** The auto-lock delay, or `AUTO_LOCK_OFF`. Storage stays the one copy of it. */
	autoLockMinutes: number;
} {
	const [state, setState] = useState({
		ready: false,
		locked: false,
		pinSet: false,
		autoLockMinutes: AUTO_LOCK_OFF,
	});

	useEffect(() => {
		const sync = () =>
			setState({
				ready: true,
				locked: isLocked(),
				pinSet: isPinSet(),
				autoLockMinutes: getAutoLockMinutes(),
			});
		sync();
		return subscribeLock(sync);
	}, []);

	return state;
}

/**
 * Everything that can lock this device while the app is open, in one place (#97):
 * time spent away, and a lock performed in another tab. Mount it once — the PIN
 * gate does, being the one component alive for the whole app — and read the
 * result through {@link usePinLock}.
 *
 * Three listeners rather than one, because no single event covers the way phones
 * actually leave:
 *
 * - `visibilitychange` is the ordinary case (app switched away, screen off).
 * - `pagehide`/`pageshow` catch the Safari/iOS back-forward cache, where a page
 *   can be frozen and restored without a visibility flip either side.
 * - The check on mount catches the reload path: a backgrounded tab that the OS
 *   discards comes back through a fresh load, and `sessionStorage` remembers it
 *   as unlocked. Without this, hours away would reopen the app uncovered.
 */
export function useLockWatch(): void {
	useEffect(() => {
		const away = () => markAway();
		const back = () => lockIfAwayTooLong();
		const onVisibilityChange = () =>
			document.visibilityState === "hidden" ? away() : back();

		back();
		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("pagehide", away);
		window.addEventListener("pageshow", back);
		window.addEventListener("storage", applyLockBroadcast);
		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("pagehide", away);
			window.removeEventListener("pageshow", back);
			window.removeEventListener("storage", applyLockBroadcast);
		};
	}, []);
}
