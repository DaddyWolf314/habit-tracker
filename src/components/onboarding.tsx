import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
	ApiError,
	confirmRoles,
	createIdentity,
	createInvite,
	dissolve,
	exportData,
	getRoles,
	getSession,
	proposeRoles,
	redeemInvite,
} from "#/lib/api.ts";
import {
	generateSecret,
	hasIdentity,
	secretFromMnemonic,
	storeSecret,
} from "#/lib/identity.ts";
import type {
	InviteResult,
	RoleConfirmationState,
	Session,
} from "#/shared/identity.ts";
import type { Role } from "#/shared/roles.ts";

type Stage =
	| { name: "loading" }
	| { name: "intro" }
	| { name: "recover" }
	| { name: "join" }
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

	async function handleJoin(code: string) {
		setBusy(true);
		setError(null);
		try {
			const { secret, mnemonic } = generateSecret();
			await redeemInvite(code.trim(), secret); // binds B into A's couple
			storeSecret(secret);
			setStage({ name: "ceremony", mnemonic });
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't join with that code.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function refreshSession() {
		const session = await getSession();
		setStage({ name: "home", session });
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
							variant="secondary"
							onClick={() => {
								setError(null);
								setStage({ name: "join" });
							}}
						>
							Join your partner
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
		case "join":
			return (
				<JoinForm
					busy={busy}
					error={error}
					onCancel={() => {
						setError(null);
						setStage({ name: "intro" });
					}}
					onSubmit={handleJoin}
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
			return <Home session={stage.session} onRefresh={refreshSession} />;
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

function JoinForm({
	busy,
	error,
	onCancel,
	onSubmit,
}: {
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSubmit: (code: string) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<Centered>
			<h2 className="text-2xl font-bold">Join your partner</h2>
			<p className="max-w-md text-muted-foreground">
				Paste the invite your partner sent you. We'll create your own recovery
				phrase next — you get your own key.
			</p>
			<input
				className="w-full max-w-md rounded-md border bg-background p-3 text-sm"
				placeholder="invite code"
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
					{busy ? "Joining…" : "Join"}
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

function Home({
	session,
	onRefresh,
}: {
	session: Session;
	onRefresh: () => void | Promise<void>;
}) {
	const dissolved = session.status === "dissolved";
	const awaitingPartner = session.member_count < 2;
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

			{dissolved ? (
				<p className="mt-6 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
					This space has been dissolved. Everything is frozen. You can still
					export your copy below.
				</p>
			) : (
				<>
					{awaitingPartner && <InvitePanel onRefresh={onRefresh} />}
					{!awaitingPartner && <RolesPanel onActivated={onRefresh} />}
				</>
			)}

			<SettingsPanel dissolved={dissolved} onDissolved={onRefresh} />

			<div className="mt-6 flex gap-4">
				{session.roles_active && (
					<Link to="/log" className="text-sm underline">
						Open the log
					</Link>
				)}
				<Link to="/devices" className="text-sm underline">
					Manage devices
				</Link>
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
function SettingsPanel({
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
		<div className="mt-6 rounded-md border p-4">
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

const ROLE_OPTIONS: Role[] = ["dom", "sub", "switch"];

/**
 * Mutual role confirmation (handoff §2). Either partner proposes who holds which
 * role; the dynamic only activates once both confirm the same assignment, and
 * that confirmation is the first entry in the consent history.
 */
function RolesPanel({
	onActivated,
}: {
	onActivated: () => void | Promise<void>;
}) {
	const [state, setState] = useState<RoleConfirmationState | null>(null);
	const [selfRole, setSelfRole] = useState<Role>("dom");
	const [partnerRole, setPartnerRole] = useState<Role>("sub");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setState(await getRoles());
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't load roles.");
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	if (!state)
		return <p className="mt-6 text-sm text-muted-foreground">Loading roles…</p>;

	const self = state.members.find((m) => m.is_self);
	const partner = state.members.find((m) => !m.is_self);

	if (state.active) {
		return (
			<div className="mt-6 rounded-md border p-4">
				<h2 className="font-medium">Roles confirmed</h2>
				<p className="mt-1 text-sm">
					You are the <strong>{self?.role}</strong>; your partner is the{" "}
					<strong>{partner?.role}</strong>.
				</p>
			</div>
		);
	}

	async function run(action: () => Promise<RoleConfirmationState>) {
		setBusy(true);
		setError(null);
		try {
			const next = await action();
			setState(next);
			if (next.active) await onActivated();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	const hasProposal = state.proposed_by !== null;
	const iProposed = state.proposed_by === self?.member_id;
	const iConfirmed = self ? state.confirmed_by.includes(self.member_id) : false;
	const partnerRoleName = partner
		? state.assignment?.[partner.member_id]
		: undefined;
	const selfRoleName = self ? state.assignment?.[self.member_id] : undefined;

	return (
		<div className="mt-6 rounded-md border p-4">
			<h2 className="font-medium">Confirm your roles</h2>
			<p className="mt-1 text-sm text-muted-foreground">
				Both of you have to agree before the dynamic starts.
			</p>

			{hasProposal && (
				<p className="mt-3 rounded bg-muted/50 p-2 text-sm">
					Proposed: you are the <strong>{selfRoleName}</strong>, your partner is
					the <strong>{partnerRoleName}</strong>.{" "}
					{iProposed ? "Waiting for your partner." : "They proposed this."}
				</p>
			)}

			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}

			{hasProposal && !iProposed && !iConfirmed ? (
				<div className="mt-3 flex gap-2">
					<Button size="sm" disabled={busy} onClick={() => run(confirmRoles)}>
						Confirm these roles
					</Button>
				</div>
			) : (
				<div className="mt-3 flex flex-wrap items-end gap-3">
					<label className="text-sm">
						<span className="block text-muted-foreground">You</span>
						<select
							className="mt-1 rounded-md border bg-background p-2 text-sm"
							value={selfRole}
							onChange={(e) => setSelfRole(e.target.value as Role)}
						>
							{ROLE_OPTIONS.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</label>
					<label className="text-sm">
						<span className="block text-muted-foreground">Your partner</span>
						<select
							className="mt-1 rounded-md border bg-background p-2 text-sm"
							value={partnerRole}
							onChange={(e) => setPartnerRole(e.target.value as Role)}
						>
							{ROLE_OPTIONS.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</label>
					<Button
						size="sm"
						disabled={busy || !self || !partner}
						onClick={() =>
							self &&
							partner &&
							run(() =>
								proposeRoles({
									[self.member_id]: selfRole,
									[partner.member_id]: partnerRole,
								}),
							)
						}
					>
						{hasProposal ? "Propose different roles" : "Propose"}
					</Button>
				</div>
			)}
		</div>
	);
}

function InvitePanel({ onRefresh }: { onRefresh: () => void | Promise<void> }) {
	const [invite, setInvite] = useState<InviteResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function generate() {
		setBusy(true);
		setError(null);
		try {
			setInvite(await createInvite());
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't create an invite.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-6 rounded-md border p-4">
			<h2 className="font-medium">Invite your partner</h2>
			<p className="mt-1 text-sm text-muted-foreground">
				Send them this code. It works once and expires in 15 minutes.
			</p>
			{invite && (
				<div className="mt-3">
					<code className="block overflow-x-auto rounded bg-muted p-2 text-xs">
						{invite.code}
					</code>
					<p className="mt-1 text-xs text-muted-foreground">
						Expires {new Date(invite.expires_at).toLocaleTimeString()}
					</p>
				</div>
			)}
			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
			<div className="mt-3 flex gap-2">
				<Button onClick={generate} disabled={busy} size="sm">
					{invite ? "New code" : "Create invite"}
				</Button>
				<Button variant="outline" size="sm" onClick={() => onRefresh()}>
					I've paired — refresh
				</Button>
			</div>
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
