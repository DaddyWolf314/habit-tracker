import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { getSession, pause, resume } from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";

/** How often the bar re-checks the session so a partner's pause surfaces. */
const POLL_MS = 20_000;

type PauseState = "hidden" | "running" | "paused";

/**
 * Pause-everything / safeword (handoff §9, #40, #87) — the always-reachable
 * control, mounted on every authenticated surface from the root layout. Pausing
 * is one tap with no confirm dialog: its whole point is availability in a
 * charged moment. While paused, a loud banner replaces the quiet button so the
 * frozen state is visible everywhere, with the resume flow right there; resume
 * takes the house two-tap inline confirm since it restarts every clock at once.
 * Either partner may do either — the bar polls the session (plus a refetch on
 * tab focus) so one side's pause reaches the other without a reload.
 */
export function PauseEverythingBar() {
	const [state, setState] = useState<PauseState>("hidden");
	const [confirmingResume, setConfirmingResume] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!hasIdentity()) {
			setState("hidden");
			return;
		}
		try {
			const session = await getSession();
			// Pre-pairing there is nothing to freeze, and a dissolved couple is
			// already frozen harder than pause — the control only means something
			// on a live, active couple.
			setState(
				session.status !== "active"
					? "hidden"
					: session.paused
						? "paused"
						: "running",
			);
		} catch {
			// A transient blip keeps the last known state; the next poll corrects it.
		}
	}, []);

	useEffect(() => {
		refresh();
		const id = setInterval(refresh, POLL_MS);
		const onVisible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [refresh]);

	async function handlePause() {
		setBusy(true);
		setError(null);
		try {
			await pause();
			setState("paused");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't pause.");
		} finally {
			setBusy(false);
		}
	}

	async function handleResume() {
		setBusy(true);
		setError(null);
		try {
			await resume();
			setState("running");
			setConfirmingResume(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't resume.");
		} finally {
			setBusy(false);
		}
	}

	if (state === "hidden") return null;

	if (state === "running") {
		return (
			<div className="mx-auto flex max-w-2xl justify-end px-6 pt-3">
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={handlePause}
				>
					{busy ? "…" : "Pause everything"}
				</Button>
				{error && (
					<p className="ml-2 self-center text-xs text-destructive">{error}</p>
				)}
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-2xl px-6 pt-3">
			<div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
				<p className="font-semibold text-amber-900">Everything is paused.</p>
				<p className="mt-1 text-sm text-amber-800">
					Tracking is frozen — countdowns wait, nothing expires, and nothing
					counts against anyone. Either of you can resume; the paused time is
					given back to every running clock.
				</p>
				{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
				<div className="mt-3 flex items-center gap-2">
					{confirmingResume ? (
						<>
							<Button size="sm" disabled={busy} onClick={handleResume}>
								{busy ? "…" : "Yes, resume everything"}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => setConfirmingResume(false)}
							>
								Stay paused
							</Button>
						</>
					) : (
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => setConfirmingResume(true)}
						>
							Resume
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
