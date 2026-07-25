import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PinSettings } from "#/components/pin-gate.tsx";
import { StatusSummary } from "#/components/status-summary.tsx";
import { Button } from "#/components/ui/button.tsx";
import { dissolve, exportData } from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import { useSession } from "#/lib/use-session.ts";

/**
 * The Settings surface (handoff §9.7, #85). Tabs made `/` a redirect to Today
 * for an active couple, so everything the old home page carried that isn't the
 * daily loop — the status readout, the PIN lock, export, dissolve, devices —
 * lives here, one tab away rather than behind it.
 */
export function SettingsView() {
	// The tab bar polls the session for the whole app; this surface only needs
	// the session it mounted with, plus a refetch once dissolve lands.
	const { session, ready, refresh } = useSession({ poll: false });

	if (!ready) return null;
	if (!hasIdentity()) {
		return (
			<div className="mx-auto max-w-2xl p-8">
				<p className="text-muted-foreground">
					You don't have a space on this device yet.{" "}
					<Link to="/" className="underline">
						Go back
					</Link>
					.
				</p>
			</div>
		);
	}
	if (!session)
		return (
			<div className="mx-auto max-w-2xl p-8">
				<p className="text-muted-foreground">Loading…</p>
			</div>
		);

	const dissolved = session.status === "dissolved";

	return (
		<div className="mx-auto max-w-2xl space-y-6 p-6">
			<h1 className="text-2xl font-bold">Settings</h1>

			<StatusSummary session={session} />

			{dissolved && (
				<p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
					This space has been dissolved. Everything is frozen. You can still
					export your copy below.
				</p>
			)}

			<YourDataPanel dissolved={dissolved} onDissolved={refresh} />

			<div className="rounded-md border p-4">
				<PinSettings />
			</div>

			<div className="rounded-md border p-4">
				<h2 className="font-medium">Your devices</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Add a phone or laptop with a device token, or revoke one to log that
					device out.
				</p>
				<div className="mt-3">
					<Link to="/devices" className="text-sm underline">
						Manage devices
					</Link>
				</div>
			</div>
		</div>
	);
}

/**
 * Export + dissolve (handoff §2, abuse-edge). Either partner can export their
 * own copy at any time and can unilaterally dissolve — no one is trapped inside
 * the app's structure. Dissolve takes a deliberate second click instead of a
 * blocking dialog.
 */
export function YourDataPanel({
	dissolved,
	onDissolved,
}: {
	dissolved: boolean;
	onDissolved: () => void | Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleExport() {
		setBusy(true);
		setError(null);
		try {
			const data = await exportData();
			const blob = new Blob([JSON.stringify(data, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "strawberry-export.json";
			anchor.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't export.");
		} finally {
			setBusy(false);
		}
	}

	async function handleDissolve() {
		setBusy(true);
		setError(null);
		try {
			await dissolve();
			setConfirming(false);
			await onDissolved();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't dissolve.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-md border p-4">
			<h2 className="font-medium">Your data</h2>
			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
			<div className="mt-3 flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={handleExport}
				>
					Export my data
				</Button>
				{!dissolved &&
					(confirming ? (
						<>
							<Button
								variant="destructive"
								size="sm"
								disabled={busy}
								onClick={handleDissolve}
							>
								Yes, dissolve everything
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => setConfirming(false)}
							>
								Cancel
							</Button>
						</>
					) : (
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => setConfirming(true)}
						>
							Dissolve this space
						</Button>
					))}
			</div>
		</div>
	);
}
