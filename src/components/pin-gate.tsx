import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { APP_NAME } from "#/lib/app-config.ts";
import { clearPin, isLocked, isPinSet, setPin, verifyPin } from "#/lib/pin.ts";

/**
 * PIN-lock gate (handoff §3.5, #42) — a discretion feature. When a PIN is set and
 * this browser session hasn't been unlocked, it covers the whole app with a
 * neutral lock screen (titled only with the cover name) until the PIN is entered.
 * It renders nothing until mounted so locked content never flashes on load, and
 * it is a no-op when no PIN is configured. This is not a security boundary — see
 * `lib/pin.ts` — it just keeps a casual glance out.
 */
export function PinGate({ children }: { children: React.ReactNode }) {
	const [ready, setReady] = useState(false);
	const [locked, setLocked] = useState(false);
	const [pin, setPinValue] = useState("");
	const [error, setError] = useState(false);

	useEffect(() => {
		setLocked(isLocked());
		setReady(true);
	}, []);

	// Avoid a flash of protected content before the lock check runs client-side.
	if (!ready) return null;
	if (!locked) return <>{children}</>;

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (await verifyPin(pin)) {
			setLocked(false);
			setPinValue("");
			setError(false);
		} else {
			setError(true);
			setPinValue("");
		}
	};

	return (
		<div className="flex min-h-screen items-center justify-center p-6">
			<form onSubmit={submit} className="w-full max-w-xs space-y-4 text-center">
				<h1 className="text-xl font-semibold">{APP_NAME}</h1>
				<Input
					type="password"
					inputMode="numeric"
					autoFocus
					aria-label="PIN"
					value={pin}
					onChange={(e) => setPinValue(e.target.value)}
					placeholder="Enter PIN"
				/>
				{error ? <p className="text-sm text-red-600">Incorrect PIN.</p> : null}
				<Button type="submit" className="w-full" disabled={pin.length === 0}>
					Unlock
				</Button>
			</form>
		</div>
	);
}

/**
 * Set, change, or remove the PIN lock. A small settings control (#42); the lock
 * takes effect on the next fresh load of the app.
 */
export function PinSettings() {
	const [hasPin, setHasPin] = useState(false);
	const [pin, setPinValue] = useState("");
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		setHasPin(isPinSet());
	}, []);

	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		if (pin.length < 4) return;
		await setPin(pin);
		setHasPin(true);
		setPinValue("");
		setSaved(true);
	};

	const remove = () => {
		clearPin();
		setHasPin(false);
		setSaved(false);
	};

	return (
		<section className="space-y-2">
			<h3 className="font-medium">PIN lock</h3>
			<p className="text-sm text-muted-foreground">
				{hasPin
					? "A PIN is set. It locks the app on next open."
					: "Set a PIN (4+ digits) to lock the app on this device."}
			</p>
			<form onSubmit={save} className="flex gap-2">
				<Input
					type="password"
					inputMode="numeric"
					aria-label={hasPin ? "New PIN" : "PIN"}
					value={pin}
					onChange={(e) => setPinValue(e.target.value)}
					placeholder={hasPin ? "New PIN" : "PIN"}
				/>
				<Button type="submit" disabled={pin.length < 4}>
					{hasPin ? "Change" : "Set"}
				</Button>
				{hasPin ? (
					<Button type="button" variant="outline" onClick={remove}>
						Remove
					</Button>
				) : null}
			</form>
			{saved ? (
				<p className="text-sm text-green-600">Saved. Locks on next open.</p>
			) : null}
		</section>
	);
}
