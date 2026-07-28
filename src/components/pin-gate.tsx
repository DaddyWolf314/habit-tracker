import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { APP_NAME } from "#/lib/app-config.ts";
import {
	AUTO_LOCK_OFF,
	clearPin,
	setAutoLockMinutes,
	setPin,
	verifyPin,
} from "#/lib/pin.ts";
import { useLockWatch, usePinLock } from "#/lib/use-pin.ts";

/**
 * PIN-lock gate (handoff §3.5, #42) — a discretion feature. When a PIN is set and
 * this browser session hasn't been unlocked, it covers the whole app with a
 * neutral lock screen (titled only with the cover name) until the PIN is entered.
 * It renders nothing until mounted so locked content never flashes on load, and
 * it is a no-op when no PIN is configured. This is not a security boundary — see
 * `lib/pin.ts` — it just keeps a casual glance out.
 *
 * It is also where `useLockWatch` is mounted (#97, #145) — the app-wide watch
 * for time away, time untouched, and a lock performed in another tab — because
 * this is the one component alive for the whole app, so a phone left face-down
 * comes back covered rather than open, and a laptop walked away from covers
 * itself where it sits.
 */
export function PinGate({ children }: { children: React.ReactNode }) {
	const { ready, locked } = usePinLock();
	useLockWatch();
	const [pin, setPinValue] = useState("");
	const [error, setError] = useState(false);

	// Avoid a flash of protected content before the lock check runs client-side.
	if (!ready) return null;
	if (!locked) return <>{children}</>;

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (await verifyPin(pin)) {
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
 * The delays on offer (#97, #145). They used to be phrased "away", back when
 * that was all the delay measured; one delay now covers both ways the app gets
 * left, so the labels name the wait and the line under the select says what
 * starts it — in one clause, because the whole point of one delay is that nobody
 * has to think about which kind of leaving they did. A minute is short on
 * purpose: the phone-handed-over case wants the shortest delay the couple will
 * tolerate, and "Lock now" is right there for the rest.
 */
const AUTO_LOCK_OPTIONS = [
	{ minutes: AUTO_LOCK_OFF, label: "Never — only when I lock it" },
	{ minutes: 1, label: "After 1 minute" },
	{ minutes: 5, label: "After 5 minutes" },
	{ minutes: 15, label: "After 15 minutes" },
	{ minutes: 60, label: "After 1 hour" },
] as const;

const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

/**
 * Set, change, or remove the PIN lock, and say when it re-engages (#42, #97).
 * The lock used to wait for the next fresh load, which meant the one control
 * here was "set it and hope you close the tab"; the delay chosen here is what
 * covers the app without anyone remembering to. Locking on purpose is not
 * repeated here — that lives in the bottom bar, within reach of this screen too,
 * and a control with two homes is a label waiting to drift between them.
 */
export function PinSettings() {
	// The delay is read through the hook rather than mirrored in state: removing a
	// PIN takes its delay with it, and a mirror would still be showing the old
	// choice to whoever sets a PIN again on the same visit.
	const { pinSet, autoLockMinutes } = usePinLock();
	const [pin, setPinValue] = useState("");
	const [saved, setSaved] = useState(false);

	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		if (pin.length < 4) return;
		await setPin(pin);
		setPinValue("");
		setSaved(true);
	};

	const remove = () => {
		clearPin();
		setSaved(false);
	};

	return (
		<section className="space-y-2">
			<h3 className="font-medium">PIN lock</h3>
			<p className="text-sm text-muted-foreground">
				{pinSet
					? "A PIN is set. Lock it any time from the bar at the bottom, and it can lock itself once the app has been left alone for a while."
					: "Set a PIN (4+ digits) to lock the app on this device."}
			</p>
			<form onSubmit={save} className="flex gap-2">
				<Input
					type="password"
					inputMode="numeric"
					aria-label={pinSet ? "New PIN" : "PIN"}
					value={pin}
					onChange={(e) => setPinValue(e.target.value)}
					placeholder={pinSet ? "New PIN" : "PIN"}
				/>
				<Button type="submit" disabled={pin.length < 4}>
					{pinSet ? "Change" : "Set"}
				</Button>
				{pinSet ? (
					<Button type="button" variant="outline" onClick={remove}>
						Remove
					</Button>
				) : null}
			</form>
			{saved ? <p className="text-sm text-green-600">Saved.</p> : null}

			{pinSet ? (
				<div className="pt-2">
					<label
						htmlFor="pin-auto-lock"
						className="text-xs text-muted-foreground"
					>
						Lock automatically
					</label>
					<select
						id="pin-auto-lock"
						className={`${fieldClass} mt-1`}
						value={autoLockMinutes}
						onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
					>
						{AUTO_LOCK_OPTIONS.map(({ minutes, label }) => (
							<option key={minutes} value={minutes}>
								{label}
							</option>
						))}
					</select>
					{autoLockMinutes !== AUTO_LOCK_OFF ? (
						<p className="mt-1 text-xs text-muted-foreground">
							Counted from the last time anyone used it.
						</p>
					) : null}
				</div>
			) : null}
		</section>
	);
}
