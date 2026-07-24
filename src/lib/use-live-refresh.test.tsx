// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveRefresh } from "./use-live-refresh.ts";

/**
 * A surface with no WebSocket push yet (the architecture plans one, handoff
 * §3.2) stays live by re-listing on a low-frequency poll and whenever the tab
 * comes back to the foreground, so a partner's event or an incoming ruling
 * appears without a manual reload (#92). These cover the three triggers, the
 * swallow, and teardown.
 */

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		value: state,
		configurable: true,
	});
}

describe("useLiveRefresh", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setVisibility("visible");
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("re-runs refresh on the interval", () => {
		const refresh = vi.fn(() => Promise.resolve());
		renderHook(() => useLiveRefresh(refresh, { intervalMs: 15_000 }));

		expect(refresh).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(15_000);
		});
		expect(refresh).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(15_000);
		});
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("refreshes when the window regains focus", () => {
		const refresh = vi.fn(() => Promise.resolve());
		renderHook(() => useLiveRefresh(refresh, { intervalMs: 15_000 }));

		act(() => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("refreshes when the tab becomes visible, not when it hides", () => {
		const refresh = vi.fn(() => Promise.resolve());
		renderHook(() => useLiveRefresh(refresh, { intervalMs: 15_000 }));

		act(() => {
			setVisibility("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(refresh).not.toHaveBeenCalled();

		act(() => {
			setVisibility("visible");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("swallows a rejected refresh so a poll blip stays quiet", () => {
		const refresh = vi.fn(() => Promise.reject(new Error("network")));
		renderHook(() => useLiveRefresh(refresh, { intervalMs: 15_000 }));

		expect(() =>
			act(() => {
				vi.advanceTimersByTime(15_000);
			}),
		).not.toThrow();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("does nothing while disabled", () => {
		const refresh = vi.fn(() => Promise.resolve());
		renderHook(() =>
			useLiveRefresh(refresh, { intervalMs: 15_000, enabled: false }),
		);

		act(() => {
			vi.advanceTimersByTime(30_000);
			window.dispatchEvent(new Event("focus"));
		});
		expect(refresh).not.toHaveBeenCalled();
	});

	it("stops polling and unbinds after unmount", () => {
		const refresh = vi.fn(() => Promise.resolve());
		const { unmount } = renderHook(() =>
			useLiveRefresh(refresh, { intervalMs: 15_000 }),
		);

		unmount();
		act(() => {
			vi.advanceTimersByTime(30_000);
			window.dispatchEvent(new Event("focus"));
		});
		expect(refresh).not.toHaveBeenCalled();
	});
});
