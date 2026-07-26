// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCopy } from "./use-copy.ts";

/**
 * Both one-shot credentials this app hands over — a device token and an invite
 * code — are copied the same way, and both can be met by a clipboard that isn't
 * there. These cover the three outcomes the button renders from.
 */

function stubClipboard(writeText: () => Promise<void>) {
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
}

describe("useCopy", () => {
	afterEach(cleanup);

	it("starts idle", () => {
		const { result } = renderHook(() => useCopy());
		expect(result.current.copied).toBe(false);
		expect(result.current.failed).toBe(false);
	});

	it("reports a copy that landed", async () => {
		const writeText = vi.fn(() => Promise.resolve());
		stubClipboard(writeText);
		const { result } = renderHook(() => useCopy());

		await act(async () => {
			await result.current.copy("abc-123");
		});

		expect(writeText).toHaveBeenCalledWith("abc-123");
		expect(result.current.copied).toBe(true);
		expect(result.current.failed).toBe(false);
	});

	it("reports a clipboard that refused, rather than going quiet", async () => {
		stubClipboard(() => Promise.reject(new Error("denied")));
		const { result } = renderHook(() => useCopy());

		await act(async () => {
			await result.current.copy("abc-123");
		});

		expect(result.current.copied).toBe(false);
		expect(result.current.failed).toBe(true);
	});

	it("survives a browser with no clipboard at all", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
		});
		const { result } = renderHook(() => useCopy());

		await act(async () => {
			await result.current.copy("abc-123");
		});

		expect(result.current.failed).toBe(true);
	});

	it("goes back to idle when the value it copied is replaced", async () => {
		stubClipboard(() => Promise.resolve());
		const { result } = renderHook(() => useCopy());

		await act(async () => {
			await result.current.copy("abc-123");
		});
		act(() => {
			result.current.reset();
		});

		expect(result.current.copied).toBe(false);
		expect(result.current.failed).toBe(false);
	});
});
