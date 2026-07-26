import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { Button } from "#/components/ui/button.tsx";
import { listDevices, mintDevice, revokeDevice } from "#/lib/api.ts";
import { clearCredentials, hasIdentity } from "#/lib/identity.ts";
import { useCopy } from "#/lib/use-copy.ts";
import type { Device } from "#/shared/identity.ts";

/**
 * "Your devices" panel (handoff §2). Each device token is individually
 * revocable; the recovery phrase stays the rarely-used root credential. A newly
 * minted token is shown exactly once — there's no way to see it again.
 *
 * Revoking has no undo and no second chance at the token, so it arms through
 * the house two-tap confirm (#117). The row flagged `current` gets its own
 * control: `current` is only ever true on a device linked *by token*, which
 * holds no root secret and so cannot re-mint for itself — revoking it there is
 * signing yourself out, not tidying up a device you left somewhere.
 */
export function DevicesPanel() {
	const [devices, setDevices] = useState<Device[] | null>(null);
	const [freshToken, setFreshToken] = useState<string | null>(null);
	const clipboard = useCopy();
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	/** The row awaiting its second tap — one at a time, so two can't sit armed. */
	const [confirming, setConfirming] = useState<string | null>(null);
	/** Set once this device has revoked its own token and dropped it. */
	const [signedOut, setSignedOut] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const { devices } = await listDevices();
			setDevices(devices);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't load devices.");
		}
	}, []);

	useEffect(() => {
		setReady(true);
		if (hasIdentity()) refresh();
	}, [refresh]);

	/**
	 * Runs one panel mutation behind the shared busy flag and error line, the way
	 * `counters-panel.tsx` does — the guard is the same for every one of them, and
	 * only the message to fall back on when the failure isn't an `Error` differs.
	 */
	async function run(fallback: string, fn: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (err) {
			setError(err instanceof Error ? err.message : fallback);
		} finally {
			setBusy(false);
		}
	}

	async function handleMint() {
		clipboard.reset();
		await run("Couldn't create a device token.", async () => {
			const trimmed = label.trim();
			const { token } = await mintDevice(trimmed === "" ? undefined : trimmed);
			setFreshToken(token);
			setLabel("");
			await refresh();
		});
	}

	async function handleRevoke(deviceId: string) {
		await run("Couldn't revoke that device.", async () => {
			await revokeDevice(deviceId);
			setConfirming(null);
			await refresh();
		});
	}

	/**
	 * Revokes the token this device is authenticating with. Nothing is re-listed
	 * afterwards — the credential is dead, so a refresh would only 401 and paint
	 * an error over the explanation. The stored bearer goes with it rather than
	 * lingering to fail the next load; nothing else local is touched, so a PIN
	 * lock set on this device outlives the space it was set in.
	 */
	async function handleSignOut(deviceId: string) {
		await run("Couldn't sign this device out.", async () => {
			await revokeDevice(deviceId);
			clearCredentials();
			setConfirming(null);
			setSignedOut(true);
		});
	}

	if (!ready) return null;
	if (signedOut) {
		return (
			<div className="mx-auto max-w-2xl p-8">
				<h1 className="text-2xl font-bold">Signed out</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					This device's token has been revoked and its copy is gone from here.
					To use your space on this device again, generate a fresh device token
					from a device that still works and add it here — nothing on this
					device can mint one for itself.
				</p>
				<Link to="/" className="mt-4 inline-block text-sm underline">
					Back to the start
				</Link>
			</div>
		);
	}
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

	return (
		<div className="mx-auto max-w-2xl p-8">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">Your devices</h1>
				{/* Devices hangs off Settings rather than earning a tab of its own
				    (#85), so back goes there, not to the old hub. */}
				<Link to="/settings" className="text-sm underline">
					Settings
				</Link>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				Device tokens are for day-to-day access. Revoke one to log that device
				out.
			</p>

			{freshToken && (
				<div className="mt-4 rounded-md border border-primary/40 bg-primary/5 p-4">
					<p className="text-sm font-medium">New device token — copy it now.</p>
					<p className="mt-1 text-xs text-muted-foreground">
						This is the only time it's shown. On your other device, choose{" "}
						<strong>Add this device with a token</strong> and paste it.
					</p>
					<code className="mt-2 block overflow-x-auto rounded bg-muted p-2 text-xs">
						{freshToken}
					</code>
					<div className="mt-2 flex gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => clipboard.copy(freshToken)}
						>
							{clipboard.copied ? "Copied" : "Copy"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setFreshToken(null);
								clipboard.reset();
							}}
						>
							Done
						</Button>
					</div>
					{clipboard.failed && (
						<p className="mt-2 text-xs text-muted-foreground">
							This browser wouldn't let us reach the clipboard — select the
							token above and copy it by hand.
						</p>
					)}
				</div>
			)}

			{error && <p className="mt-4 text-sm text-destructive">{error}</p>}

			<div className="mt-6 flex flex-wrap items-center gap-2">
				<input
					className="rounded-md border bg-background p-2 text-sm"
					placeholder="Name this device (optional)"
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					maxLength={100}
				/>
				<Button onClick={handleMint} disabled={busy}>
					{busy ? "…" : "Generate a device token"}
				</Button>
			</div>

			<ul className="mt-6 divide-y rounded-md border">
				{devices?.length === 0 && (
					<li className="p-4 text-sm text-muted-foreground">No devices yet.</li>
				)}
				{devices?.map((device) => (
					<li key={device.device_id} className="p-4">
						<div className="flex items-center justify-between gap-3">
							<div className="text-sm">
								<div className="font-medium">
									{device.label ?? "Device"}
									{device.current && (
										<span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
											this device
										</span>
									)}
									{device.revoked_at && (
										<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
											revoked
										</span>
									)}
								</div>
								<div className="text-xs text-muted-foreground">
									Added {new Date(device.created_at).toLocaleString()}
								</div>
							</div>
							{!device.revoked_at &&
								(confirming === device.device_id ? (
									<InlineConfirm
										label={device.current ? "Yes, sign out" : "Yes, revoke"}
										busy={busy}
										onConfirm={() =>
											device.current
												? handleSignOut(device.device_id)
												: handleRevoke(device.device_id)
										}
										onCancel={() => setConfirming(null)}
									/>
								) : (
									<Button
										variant="outline"
										size="sm"
										disabled={busy}
										onClick={() => setConfirming(device.device_id)}
									>
										{device.current ? "Sign this device out" : "Revoke"}
									</Button>
								))}
						</div>
						{/* What the tap costs, named where the tap is: there is no
						    un-revoke, and a token is shown exactly once (#117). */}
						{confirming === device.device_id && (
							<p className="mt-2 text-xs text-muted-foreground">
								{device.current
									? "You'll be logged out here and this device's token stops working. Getting back in needs a fresh token from a device that still works."
									: "That device is logged out for good. Using it again needs a fresh token generated here — the one it holds can't be shown again."}
							</p>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
