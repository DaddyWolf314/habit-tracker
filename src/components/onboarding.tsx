import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { StatusSummary } from "#/components/status-summary.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	ApiError,
	confirmRoles,
	createIdentity,
	createInvite,
	getRoles,
	getSession,
	linkDevice,
	proposeRoles,
	redeemInvite,
} from "#/lib/api.ts";
import {
	clearCredentials,
	generateSecret,
	hasIdentity,
	secretFromMnemonic,
	storeDeviceToken,
	storeSecret,
} from "#/lib/identity.ts";
import { matchesWordAt, pickCheckPositions } from "#/lib/recovery-check.ts";
import { LIVE_REFRESH_MS, useLiveRefresh } from "#/lib/use-live-refresh.ts";
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
	| { name: "link" }
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
			.catch((err) => {
				// A stored credential the server no longer honours (e.g. a revoked
				// device token) should not linger and re-fail every load.
				if (err instanceof ApiError && err.status === 401) clearCredentials();
				setStage({ name: "intro" });
			});
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
		setError(null);
		try {
			const session = await getSession();
			setStage({ name: "home", session });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function handleRecover(mnemonic: string) {
		setBusy(true);
		setError(null);
		try {
			const secret = secretFromMnemonic(mnemonic);
			const session = await getSession(secret); // validate before persisting
			storeSecret(secret);
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

	async function handleLink(token: string) {
		setBusy(true);
		setError(null);
		try {
			const session = await linkDevice(token); // validate before persisting
			storeDeviceToken(token.trim());
			setStage({ name: "home", session });
		} catch (err) {
			const message =
				err instanceof ApiError && err.status === 401
					? "That device token isn't valid or has been revoked."
					: err instanceof Error
						? err.message
						: "Couldn't link this device.";
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

	// Stable across renders: the invite panel polls with it (#96), and a fresh
	// identity each render would restart that poll's interval on every keystroke.
	const refreshSession = useCallback(async () => {
		const session = await getSession();
		setStage({ name: "home", session });
	}, []);

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
						<Button
							variant="link"
							onClick={() => {
								setError(null);
								setStage({ name: "link" });
							}}
						>
							Add this device with a token
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
		case "link":
			return (
				<LinkDeviceForm
					busy={busy}
					error={error}
					onCancel={() => {
						setError(null);
						setStage({ name: "intro" });
					}}
					onSubmit={handleLink}
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
					error={error}
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

function LinkDeviceForm({
	busy,
	error,
	onCancel,
	onSubmit,
}: {
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSubmit: (token: string) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<Centered>
			<h2 className="text-2xl font-bold">Add this device</h2>
			<p className="max-w-md text-muted-foreground">
				On a device you're already signed in on, open{" "}
				<strong>Your devices</strong>, generate a device token, and paste it
				here. It gives this device its own key — revocable on its own, without
				touching your recovery phrase.
			</p>
			<input
				className="w-full max-w-md rounded-md border bg-background p-3 text-sm"
				placeholder="device token"
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
					{busy ? "Linking…" : "Add device"}
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

export function Ceremony({
	mnemonic,
	busy,
	error,
	onDone,
}: {
	mnemonic: string;
	busy: boolean;
	error: string | null;
	onDone: () => void;
}) {
	const [step, setStep] = useState<"show" | "check">("show");
	const [saved, setSaved] = useState(false);
	// Precompute stable keys: words can repeat, so position is part of identity.
	const words = mnemonic.split(" ").map((word, i) => ({
		key: `${i + 1}-${word}`,
		position: i + 1,
		word,
	}));
	// Drawn once per ceremony, and held out here so a trip back to re-read the
	// phrase doesn't reshuffle the question that sent them there.
	const [positions] = useState(() => pickCheckPositions(words.length));

	if (step === "check")
		return (
			<PhraseCheck
				mnemonic={mnemonic}
				positions={positions}
				busy={busy}
				error={error}
				onBack={() => setStep("show")}
				onPassed={onDone}
			/>
		);

	return (
		<Centered>
			<h2 className="text-2xl font-bold">This is your only key</h2>
			<p className="max-w-md text-muted-foreground">
				Write these 24 words down and keep them somewhere safe. We can't reset
				them because we don't know who you are — that's the point. We'll ask you
				for a few of them next.
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
			<Button onClick={() => setStep("check")} disabled={!saved || busy}>
				Continue
			</Button>
		</Centered>
	);
}

/**
 * The ceremony's confirmation step (#96): the phrase can't be reset by anyone,
 * so a checkbox alone lets a whole space rest on words nobody ever copied down.
 * Asking a few of them back catches that while the phrase is still on screen.
 *
 * The check is a transcription check, not a gate — going back to re-read the
 * phrase is one tap away, and it asks about the same words when you return.
 */
function PhraseCheck({
	mnemonic,
	positions,
	busy,
	error,
	onBack,
	onPassed,
}: {
	mnemonic: string;
	positions: number[];
	busy: boolean;
	error: string | null;
	onBack: () => void;
	onPassed: () => void;
}) {
	const [answers, setAnswers] = useState<Record<number, string>>({});
	const [missed, setMissed] = useState(false);

	const complete = positions.every((p) => (answers[p] ?? "").trim() !== "");

	function submit() {
		if (positions.every((p) => matchesWordAt(mnemonic, p, answers[p] ?? "")))
			onPassed();
		else setMissed(true);
	}

	return (
		<Centered>
			<h2 className="text-2xl font-bold">Check your copy</h2>
			<p className="max-w-md text-muted-foreground">
				Read these back from what you wrote down — not from the screen. It's the
				only way either of us finds out now rather than later.
			</p>
			<div className="flex max-w-md flex-col gap-3">
				{positions.map((position) => (
					<label key={position} className="flex items-center gap-3 text-sm">
						<span className="w-20 text-right text-muted-foreground tabular-nums">
							Word {position}
						</span>
						<input
							className="w-48 rounded-md border bg-background p-2 text-sm"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							value={answers[position] ?? ""}
							onChange={(e) => {
								setMissed(false);
								setAnswers((prev) => ({
									...prev,
									[position]: e.target.value,
								}));
							}}
						/>
					</label>
				))}
			</div>
			{missed && (
				<ErrorText>
					That doesn't match the phrase we showed you. Check what you wrote
					down.
				</ErrorText>
			)}
			{error && <ErrorText>{error}</ErrorText>}
			<div className="flex gap-2">
				<Button variant="outline" onClick={onBack} disabled={busy}>
					Show me the phrase again
				</Button>
				<Button onClick={submit} disabled={!complete || busy}>
					{busy ? "…" : "Continue"}
				</Button>
			</div>
		</Centered>
	);
}

/**
 * The pre-dynamic home: pairing and role confirmation, and nothing else. Once
 * both partners confirm, `/` stops being a place — it redirects to Today, the
 * daily loop, and the tab bar takes over navigation (#85). Everything this page
 * used to also carry (PIN lock, export, dissolve, devices) moved to Settings,
 * which stays reachable from here so a half-paired couple isn't cut off from it.
 */
function Home({
	session,
	onRefresh,
}: {
	session: Session;
	onRefresh: () => void | Promise<void>;
}) {
	const navigate = useNavigate();
	const dissolved = session.status === "dissolved";
	const awaitingPartner = session.member_count < 2;
	// A dissolved space has no daily loop left, so it lands on Settings instead —
	// the frozen-space notice and the export are both there.
	const destination = dissolved
		? "/settings"
		: session.roles_active
			? "/today"
			: null;

	useEffect(() => {
		if (destination) navigate({ to: destination, replace: true });
	}, [destination, navigate]);

	if (destination) return null;

	return (
		<div className="mx-auto max-w-2xl p-8">
			<h1 className="text-2xl font-bold">Your space</h1>
			<div className="mt-6">
				<StatusSummary session={session} />
			</div>

			{awaitingPartner ? (
				<InvitePanel onRefresh={onRefresh} />
			) : (
				<RolesPanel onActivated={onRefresh} />
			)}

			<div className="mt-6">
				<Link to="/settings" className="text-sm underline">
					Settings
				</Link>
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
export function RolesPanel({
	onActivated,
}: {
	onActivated: () => void | Promise<void>;
}) {
	const [state, setState] = useState<RoleConfirmationState | null>(null);
	const [selfRole, setSelfRole] = useState<Role>("dom");
	const [partnerRole, setPartnerRole] = useState<Role>("sub");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Confirming is the tap that activates the couple, and it is one-way: after it
	// `proposeRoles` throws "roles are already confirmed" and no endpoint reassigns
	// roles, so a wrong assignment can only be undone by dissolving the space and
	// losing its history. It takes the house guard, and says why.
	const [confirming, setConfirming] = useState(false);

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
				<div className="mt-3">
					{confirming && (
						<p className="mb-2 text-sm text-muted-foreground">
							This starts the dynamic, and roles can't be reassigned afterwards
							— changing them later means dissolving the space.
						</p>
					)}
					<div className="flex gap-2">
						{confirming ? (
							<InlineConfirm
								label="Yes, these are our roles"
								cancelLabel="Not yet"
								tone="neutral"
								busy={busy}
								onConfirm={() => run(confirmRoles)}
								onCancel={() => setConfirming(false)}
							/>
						) : (
							<Button
								size="sm"
								disabled={busy}
								onClick={() => setConfirming(true)}
							>
								Confirm these roles
							</Button>
						)}
					</div>
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

/**
 * Minting the invite and waiting on the partner (#96). The panel is on screen
 * precisely while the couple is one member short, so it polls the session on the
 * shared cadence: the join lands on the *other* device, and the person staring
 * at this one has no way to know it happened. Once the second member appears the
 * session says so, and the home swaps this panel for role confirmation.
 */
export function InvitePanel({
	onRefresh,
}: {
	onRefresh: () => void | Promise<void>;
}) {
	const [invite, setInvite] = useState<InviteResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Minting a code drops every prior unused invite for the couple, so a second
	// tap kills the code already sent — the partner hits "invalid invite code"
	// mid-redeem. The first mint has nothing to lose, so only replacing is guarded.
	const [confirmingReplace, setConfirmingReplace] = useState(false);

	const refresh = useCallback(async () => {
		await onRefresh();
	}, [onRefresh]);
	useLiveRefresh(refresh, { intervalMs: LIVE_REFRESH_MS });

	async function handleCopy(code: string) {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
		} catch {
			// The clipboard can be unavailable (insecure context, denied permission);
			// the code is on screen to select by hand, so this is a convenience only.
		}
	}

	async function generate() {
		setBusy(true);
		setError(null);
		setCopied(false);
		try {
			setInvite(await createInvite());
			setConfirmingReplace(false);
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
					<div className="mt-2 flex items-center gap-3">
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleCopy(invite.code)}
						>
							{copied ? "Copied" : "Copy"}
						</Button>
						<p className="text-xs text-muted-foreground">
							Expires {new Date(invite.expires_at).toLocaleTimeString()}
						</p>
					</div>
					<p className="mt-2 text-xs text-muted-foreground">
						Waiting for them to join — this page moves on by itself once they
						do.
					</p>
				</div>
			)}
			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
			{confirmingReplace && (
				<p className="mt-3 text-sm text-muted-foreground">
					A new code replaces this one — if you've already sent it, your partner
					will get "invalid invite code".
				</p>
			)}
			<div className="mt-3 flex gap-2">
				{confirmingReplace ? (
					<InlineConfirm
						label="Yes, replace it"
						cancelLabel="Keep the old code"
						busy={busy}
						onConfirm={generate}
						onCancel={() => setConfirmingReplace(false)}
					/>
				) : (
					<Button
						onClick={() => (invite ? setConfirmingReplace(true) : generate())}
						disabled={busy}
						size="sm"
					>
						{invite ? "New code" : "Create invite"}
					</Button>
				)}
				{/* The poll covers this; it stays for the tab that was asleep through
				    the last tick, and for anyone who doesn't want to wait one out. */}
				<Button variant="ghost" size="sm" onClick={() => onRefresh()}>
					Check now
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
