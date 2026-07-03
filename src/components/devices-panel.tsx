import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { listDevices, mintDevice, revokeDevice } from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import type { Device } from "#/shared/identity.ts";

/**
 * "Your devices" panel (handoff §2). Each device token is individually
 * revocable; the recovery phrase stays the rarely-used root credential. A newly
 * minted token is shown exactly once — there's no way to see it again.
 */
export function DevicesPanel() {
	const [devices, setDevices] = useState<Device[] | null>(null);
	const [freshToken, setFreshToken] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [ready, setReady] = useState(false);

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

	async function handleMint() {
		setBusy(true);
		setError(null);
		try {
			const { token } = await mintDevice();
			setFreshToken(token);
			await refresh();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't create a device token.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function handleRevoke(deviceId: string) {
		setBusy(true);
		setError(null);
		try {
			await revokeDevice(deviceId);
			await refresh();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't revoke that device.",
			);
		} finally {
			setBusy(false);
		}
	}

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

	return (
		<div className="mx-auto max-w-2xl p-8">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">Your devices</h1>
				<Link to="/" className="text-sm underline">
					Back
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
						This is the only time it's shown.
					</p>
					<code className="mt-2 block overflow-x-auto rounded bg-muted p-2 text-xs">
						{freshToken}
					</code>
					<Button
						variant="ghost"
						size="sm"
						className="mt-2"
						onClick={() => setFreshToken(null)}
					>
						Done
					</Button>
				</div>
			)}

			{error && <p className="mt-4 text-sm text-destructive">{error}</p>}

			<div className="mt-6">
				<Button onClick={handleMint} disabled={busy}>
					{busy ? "…" : "Generate a device token"}
				</Button>
			</div>

			<ul className="mt-6 divide-y rounded-md border">
				{devices?.length === 0 && (
					<li className="p-4 text-sm text-muted-foreground">No devices yet.</li>
				)}
				{devices?.map((device) => (
					<li
						key={device.device_id}
						className="flex items-center justify-between p-4"
					>
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
						{!device.revoked_at && (
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => handleRevoke(device.device_id)}
							>
								Revoke
							</Button>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
