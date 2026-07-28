import { useEffect, useState } from "react";
import {
	AUTO_LOCK_OFF,
	applyLockBroadcast,
	getAutoLockMinutes,
	isLocked,
	isPinSet,
	lockIfAwayTooLong,
	lockIfUntouchedTooLong,
	markAway,
	markTouched,
	msLeftOfAutoLock,
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
 * Everything that can lock this device while the app is open, in one place (#97,
 * #145): time spent away, time spent untouched, and a lock performed in another
 * tab. Mount it once — the PIN gate does, being the one component alive for the
 * whole app — and read the result through {@link usePinLock}.
 */
export function useLockWatch(): void {
	useAwayWatch();
	useUntouchedWatch();
	useLockBroadcastWatch();
}

/**
 * Locks when the app comes back from longer than the delay out of view (#97).
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
function useAwayWatch(): void {
	useEffect(() => {
		const away = () => markAway();
		const back = () => lockIfAwayTooLong();
		const onVisibilityChange = () =>
			document.visibilityState === "hidden" ? away() : back();

		back();
		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("pagehide", away);
		window.addEventListener("pageshow", back);
		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("pagehide", away);
			window.removeEventListener("pageshow", back);
		};
	}, []);
}

/** Applies a lock performed in another tab on this device (#97). */
function useLockBroadcastWatch(): void {
	useEffect(() => {
		window.addEventListener("storage", applyLockBroadcast);
		return () => window.removeEventListener("storage", applyLockBroadcast);
	}, []);
}

/**
 * What says somebody is still there. Listened for on the way down (capture)
 * rather than up, because a `scroll` inside any element of the app never bubbles
 * as far as the window — and scrolling a list is exactly the reading someone
 * does without touching anything else.
 *
 * `visibilitychange` counts too, and is handled separately: it fires at the
 * document, and it also decides whether this tab keeps a timer at all.
 */
const TOUCH_EVENTS = ["pointerdown", "keydown", "scroll"] as const;

/**
 * How often a touch is allowed to reach storage, so the other tabs on the device
 * know somebody is here (#145). Comfortably under the shortest delay on offer
 * (one minute) so a tab in use always says so in time, and far enough apart that
 * a scroll costs a variable assignment rather than a write.
 */
const TOUCH_SHARE_INTERVAL_MS = 15_000;

/**
 * Locks after the delay passes with nobody touching a tab that never left (#145).
 *
 * Unlike the away path this needs a real timer: nothing announces "nobody has
 * touched this in ten minutes" the way `visibilitychange` announces a departure.
 * Three things keep that cheap:
 *
 * - The touch handlers only assign to a variable, and tell the rest of the
 *   device at most once every {@link TOUCH_SHARE_INTERVAL_MS}. Writing storage
 *   on every pointer move or scroll frame is a cost worth avoiding on a phone.
 * - One timeout at a time, re-armed for whatever is left of the delay when it
 *   finds a more recent touch. A tab in use wakes about once per delay, not on
 *   any polling interval.
 * - A hidden tab keeps no timer at all: that time is the away rule's to judge,
 *   on return, so there is nothing here for the browser to throttle.
 *
 * It runs only while there is something to cover — a PIN, a delay, and an
 * unlocked tab — so nothing is scheduled on the devices that never asked for it.
 */
function useUntouchedWatch(): void {
	const { locked, pinSet, autoLockMinutes } = usePinLock();

	useEffect(() => {
		if (locked || !pinSet || autoLockMinutes === AUTO_LOCK_OFF) return;
		const delay = autoLockMinutes * 60_000;
		let lastTouchedAt = Date.now();
		let lastSharedAt = 0;
		let timer: ReturnType<typeof setTimeout>;

		const arm = (ms: number) => {
			clearTimeout(timer);
			timer = setTimeout(checkDeadline, ms);
		};

		const touch = () => {
			lastTouchedAt = Date.now();
			if (lastTouchedAt - lastSharedAt < TOUCH_SHARE_INTERVAL_MS) return;
			lastSharedAt = lastTouchedAt;
			markTouched(lastTouchedAt);
		};

		const checkDeadline = () => {
			// Only ever reached while hidden if the tab was already hidden when this
			// mounted; `onVisibility` arms a fresh wait when it comes back.
			if (document.visibilityState === "hidden") return;

			const remaining = msLeftOfAutoLock(lastTouchedAt, autoLockMinutes);
			if (remaining > 0) return arm(remaining);
			if (lockIfUntouchedTooLong(lastTouchedAt)) return;

			// It declined: another tab on the device is in use, or the delay or the
			// PIN went away in a tab whose storage write this one never hears about.
			// Start the wait over rather than stop watching for the life of the tab.
			lastTouchedAt = Date.now();
			arm(delay);
		};

		const onVisibility = () => {
			touch();
			if (document.visibilityState === "hidden") clearTimeout(timer);
			else arm(delay);
		};

		arm(delay);
		for (const event of TOUCH_EVENTS) {
			window.addEventListener(event, touch, { capture: true, passive: true });
		}
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			clearTimeout(timer);
			for (const event of TOUCH_EVENTS) {
				window.removeEventListener(event, touch, { capture: true });
			}
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [locked, pinSet, autoLockMinutes]);
}
