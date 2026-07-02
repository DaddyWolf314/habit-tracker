import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { ApiError, createIdentity, getSession } from "#/lib/api.ts";
import {
	generateSecret,
	hasIdentity,
	secretFromMnemonic,
	storeSecret,
} from "#/lib/identity.ts";
import type { Session } from "#/shared/identity.ts";

type Stage =
	| { name: "loading" }
	| { name: "intro" }
	| { name: "recover" }
	| { name: "ceremony"; mnemonic: string }
	| { name: "home"; session: Session };

/**
 * Onboarding + the recovery-phrase ceremony (handoff §2, §9.1). Everything here
 * is client-only: the secret lives in this browser, and the server is handed
 * nothing but a hash. Later phases layer devices, pairing, and roles onto the
 * authenticated home.
 */
export function Onboarding() {
	const [stage, setStage] = useState<Stage>({ name: "loading" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!hasIdentity()) {
			setStage({ name: "intro" });
			return;
		}
		getSession()
			.then((session) => setStage({ name: "home", session }))
			.catch(() => setStage({ name: "intro" }));
	}, []);

	async function handleCreate() {
		setBusy(true);
		setError(null);
		try {
			const { secret, mnemonic } = generateSecret();
			await createIdentity(secret); // server stores only the hash
			storeSecret(secret); // persist locally only after the couple exists
			setStage({ name: "ceremony", mnemonic });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function finishCeremony() {
		setBusy(true);
		try {
			const session = await getSession();
			setStage({ name: "home", session });
		} finally {
			setBusy(false);
		}
	}

	async function handleRecover(mnemonic: string) {
		setBusy(true);
		setError(null);
		try {
			const secret = secretFromMnemonic(mnemonic);
			storeSecret(secret);
			const session = await getSession();
			setStage({ name: "home", session });
		} catch (err) {
			const message =
				err instanceof ApiError && err.status === 401
					? "No account matches that phrase on this server."
					: err instanceof Error
						? err.message
						: "Couldn't recover.";
			setError(message);
		} finally {
			setBusy(false);
		}
	}

	switch (stage.name) {
		case "loading":
			return <Centered>Loading…</Centered>;
		case "intro":
			return (
				<Centered>
					<h1 className="text-3xl font-bold">A private space for two</h1>
					<p className="max-w-md text-muted-foreground">
						No email, no password. Your device holds the only key — we store
						just a hash, so there's nothing to leak and nothing we can reset.
					</p>
					{error && <ErrorText>{error}</ErrorText>}
					<div className="flex flex-col gap-2">
						<Button onClick={handleCreate} disabled={busy}>
							{busy ? "Creating…" : "Create your space"}
						</Button>
						<Button
							variant="link"
							onClick={() => {
								setError(null);
								setStage({ name: "recover" });
							}}
						>
							I already have a recovery phrase
						</Button>
					</div>
				</Centered>
			);
		case "recover":
			return (
				<RecoverForm
					busy={busy}
					error={error}
					onCancel={() => {
						setError(null);
						setStage({ name: "intro" });
					}}
					onSubmit={handleRecover}
				/>
			);
		case "ceremony":
			return (
				<Ceremony
					mnemonic={stage.mnemonic}
					busy={busy}
					onDone={finishCeremony}
				/>
			);
		case "home":
			return <Home session={stage.session} />;
	}
}

function RecoverForm({
	busy,
	error,
	onCancel,
	onSubmit,
}: {
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSubmit: (mnemonic: string) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<Centered>
			<h2 className="text-2xl font-bold">Enter your recovery phrase</h2>
			<textarea
				className="min-h-28 w-full max-w-md rounded-md border bg-background p-3 text-sm"
				placeholder="word one, word two, … (24 words)"
				value={value}
				onChange={(e) => setValue(e.target.value)}
			/>
			{error && <ErrorText>{error}</ErrorText>}
			<div className="flex gap-2">
				<Button variant="outline" onClick={onCancel} disabled={busy}>
					Back
				</Button>
				<Button
					onClick={() => onSubmit(value)}
					disabled={busy || value.trim() === ""}
				>
					{busy ? "Recovering…" : "Recover"}
				</Button>
			</div>
		</Centered>
	);
}

function Ceremony({
	mnemonic,
	busy,
	onDone,
}: {
	mnemonic: string;
	busy: boolean;
	onDone: () => void;
}) {
	const [saved, setSaved] = useState(false);
	// Precompute stable keys: words can repeat, so position is part of identity.
	const words = mnemonic.split(" ").map((word, i) => ({
		key: `${i + 1}-${word}`,
		position: i + 1,
		word,
	}));
	return (
		<Centered>
			<h2 className="text-2xl font-bold">This is your only key</h2>
			<p className="max-w-md text-muted-foreground">
				Write these 24 words down and keep them somewhere safe. We can't reset
				them because we don't know who you are — that's the point.
			</p>
			<ol className="grid max-w-md grid-cols-3 gap-x-4 gap-y-1 rounded-md border bg-muted/40 p-4 text-sm">
				{words.map((item) => (
					<li key={item.key} className="tabular-nums text-muted-foreground">
						<span className="mr-2 inline-block w-5 text-right">
							{item.position}.
						</span>
						<span className="font-medium text-foreground">{item.word}</span>
					</li>
				))}
			</ol>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={saved}
					onChange={(e) => setSaved(e.target.checked)}
				/>
				I've written down my recovery phrase.
			</label>
			<Button onClick={onDone} disabled={!saved || busy}>
				{busy ? "…" : "Continue"}
			</Button>
		</Centered>
	);
}

function Home({ session }: { session: Session }) {
	return (
		<div className="mx-auto max-w-2xl p-8">
			<h1 className="text-2xl font-bold">Your space</h1>
			<dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
				<dt className="text-muted-foreground">Status</dt>
				<dd className="font-medium">{session.status}</dd>
				<dt className="text-muted-foreground">Members</dt>
				<dd className="font-medium">{session.member_count} of 2</dd>
				<dt className="text-muted-foreground">Your role</dt>
				<dd className="font-medium">{session.role ?? "not set"}</dd>
			</dl>
			{session.status === "pairing" && session.member_count < 2 && (
				<p className="mt-6 text-sm text-muted-foreground">
					Next: invite your partner to join. (Coming in the pairing flow.)
				</p>
			)}
		</div>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center gap-4 p-8 text-center">
			{children}
		</div>
	);
}

function ErrorText({ children }: { children: React.ReactNode }) {
	return <p className="text-sm text-destructive">{children}</p>;
}
