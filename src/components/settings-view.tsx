import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { PinSettings } from "#/components/pin-gate.tsx";
import { StatusSummary } from "#/components/status-summary.tsx";
import { Button } from "#/components/ui/button.tsx";
import { pageClass, pageColumnsClass } from "#/components/ui/page.ts";
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
			<div className={pageClass}>
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
			<div className={pageClass}>
				<p className="text-muted-foreground">Loading…</p>
			</div>
		);

	const dissolved = session.status === "dissolved";

	return (
		<div className={`${pageColumnsClass} space-y-6`}>
			<h1 className="text-2xl font-bold lg:text-3xl">Settings</h1>

			<StatusSummary session={session} />

			{dissolved && (
				<p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
					This space has been dissolved. Everything is frozen. You can still
					export your copy below.
				</p>
			)}

			{/* Every card below is a self-contained errand — set a PIN, go read the
			    rules, export. None of them is a step in the one before it, so a
			    single column was only ever the phone's constraint speaking, and on a
			    laptop it pushed "Your devices" off the bottom of a screen with room
			    for the lot. Two columns at `lg`; row-major, so the reading order is
			    the order in the document either way. */}
			<div className="grid gap-6 lg:grid-cols-2">
				<YourDataPanel dissolved={dissolved} onDissolved={refresh} />

				<div className="rounded-md border p-4">
					<PinSettings />
				</div>

				{/* Rules live here rather than in the tab bar (#123, handoff §9 surface
			    7): authoring automation is a rare act, and the bar is for what you
			    reach daily. What your partner *changed* is not rare-use — that
			    notice stays on Today, where the person bound by it will see it. */}
				<div className="rounded-md border p-4">
					<h2 className="font-medium">Rules</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						The automations that turn what you log into your counters and
						timers. Everyone can read them; a dom or switch can change them.
					</p>
					<div className="mt-3">
						<Link to="/rules" className="text-sm underline">
							View rules
						</Link>
					</div>
				</div>

				{/* Beside Rules for the same reason (#123, #194): setting a store up is a
			    rare act. *Browsing* it is not — that entrance is on Today, beside the
			    line that says what you can afford. */}
				<div className="rounded-md border p-4">
					<h2 className="font-medium">Rewards</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						What's on offer and what it costs. The app ships none — what's
						offered, and its price, is yours to agree.
					</p>
					<div className="mt-3">
						<Link to="/rewards" className="text-sm underline">
							View rewards
						</Link>
					</div>
				</div>

				{/* Beside Rules for the same reason (#123): authoring is a rare act, and
			    the tab bar is for what you reach daily. You add a word once and then
			    use it from the composer for months. */}
				<div className="rounded-md border p-4">
					<h2 className="font-medium">Your words</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						The app ships a starting vocabulary — acts, activities, severities.
						Add your own to any of those lists.
					</p>
					<div className="mt-3">
						<Link to="/vocabulary" className="text-sm underline">
							Edit your words
						</Link>
					</div>
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
						<InlineConfirm
							label="Yes, dissolve everything"
							busy={busy}
							onConfirm={handleDissolve}
							onCancel={() => setConfirming(false)}
						/>
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
