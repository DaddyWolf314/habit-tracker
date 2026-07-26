import { useCallback, useState } from "react";

/**
 * Copy-to-clipboard for the one-shot credentials this app hands over — a minted
 * device token, an invite code. The clipboard is a convenience, not the only
 * path: it is absent in an insecure context and refusable by permission, so the
 * value is always on screen to select by hand and a refusal is reported rather
 * than swallowed (#96) — a button that does nothing when tapped reads as a
 * broken app, and the credential is the one thing that must not go missing.
 *
 * `reset` is for the caller that replaces the value under the button: the label
 * must not still read "Copied" about a code that no longer exists.
 */
export function useCopy(): {
	copied: boolean;
	failed: boolean;
	copy: (value: string) => Promise<void>;
	reset: () => void;
} {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

	const copy = useCallback(async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			setState("copied");
		} catch {
			setState("failed");
		}
	}, []);

	const reset = useCallback(() => setState("idle"), []);

	return {
		copied: state === "copied",
		failed: state === "failed",
		copy,
		reset,
	};
}
