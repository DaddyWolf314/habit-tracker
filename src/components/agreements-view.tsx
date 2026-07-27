import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import {
	createAgreement,
	deleteAgreement,
	getRoles,
	listAgreementKinds,
	listAgreements,
	retireAgreement,
	reviseAgreement,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import {
	type AgreementKind,
	agreementEffectiveAt,
	authorsKind,
	latestAgreementVersion,
	type VersionedAgreement,
} from "#/shared/agreements.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { Role } from "#/shared/roles.ts";

const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

/**
 * The Agreements screen (#121, ADR 0006) — the couple's terms of record.
 *
 * A **reference document, not a checklist**, in spite of handoff §1's "sub sees
 * a protocol checklist". You do not tick a limit: a standing term is satisfied by
 * the *absence* of an event, and the one tickable kind is ticked by logging a
 * `ritual_completed`, which the composer already owns. The daily "what's expected
 * of me" slice belongs on Today, through the counter targets a tracked ritual
 * scaffolds (#88) — building it here too would give the couple two doors to the
 * same room.
 *
 * One screen for both roles, with authoring gated per kind, following how
 * role-asymmetry is expressed everywhere else here (the queue hides for the sub,
 * panels take the viewer's role) rather than introducing the app's first
 * divergent screen pair. So the dom sees "Add a protocol" and the sub sees "Add a
 * limit", on the same page, and neither sees the other's button.
 */
export function AgreementsView() {
	const [ready, setReady] = useState(false);
	const [kinds, setKinds] = useState<AgreementKind[]>([]);
	const [agreements, setAgreements] = useState<VersionedAgreement[]>([]);
	const [members, setMembers] = useState<RoleMember[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState<string | null>(null);

	const load = useCallback(async () => {
		const [kindRes, agreementRes, roleRes] = await Promise.all([
			listAgreementKinds(),
			listAgreements(),
			getRoles(),
		]);
		setKinds(kindRes.kinds);
		setAgreements(agreementRes.agreements);
		setMembers(roleRes.members);
	}, []);

	const reload = useCallback(async () => {
		try {
			await load();
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't load your agreements.",
			);
		}
	}, [load]);

	useEffect(() => {
		setReady(true);
		if (hasIdentity()) reload();
	}, [reload]);

	const selfRole = (members.find((m) => m.is_self)?.role ??
		null) as Role | null;

	// Held in state and ticked, like the countdown panels: this screen's whole
	// announced-draft affordance turns on a version crossing its `effective_from`,
	// and a render-time read would leave "changes soon" up until some unrelated
	// state change happened to repaint. A minute is plenty — nothing here is a
	// clock, it is a boundary that gets crossed once.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(id);
	}, []);

	// Retired terms stay readable — a citation made while one stood still resolves
	// against it — but they are not what binds the couple now, so they sit apart
	// rather than among the live ones.
	const { live, retired } = useMemo(() => {
		const live: VersionedAgreement[] = [];
		const retired: VersionedAgreement[] = [];
		for (const a of agreements) {
			(agreementEffectiveAt(a, now)?.retired ? retired : live).push(a);
		}
		return { live, retired };
	}, [agreements, now]);

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
		<div className="mx-auto max-w-2xl space-y-4 p-6">
			<h1 className="text-2xl font-bold">Agreements</h1>
			<p className="text-sm text-muted-foreground">
				What the two of you have agreed. Everything here is shared — a term
				binds you both, so you can both always read it.
			</p>

			{error && <p className="text-sm text-destructive">{error}</p>}

			{agreements.length === 0 && (
				// Nothing ships in the corpus: a default term is one nobody consented
				// to but everybody has. So the first run is empty on purpose, and has
				// to say what the screen is for rather than look broken.
				<section className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
					<p className="font-medium text-foreground">
						Nothing written down yet.
					</p>
					<p className="mt-2">
						Anything you've agreed can live here — a standing expectation, a
						ritual, a limit, a safeword. Writing it down is what lets the log
						point at it later, when something is kept or broken.
					</p>
				</section>
			)}

			{kinds.map((kind) => (
				<KindSection
					key={kind.id}
					kind={kind}
					agreements={live.filter((a) => a.kind === kind.id)}
					now={now}
					canAuthor={authorsKind(kinds, kind.id, selfRole)}
					adding={adding === kind.id}
					onAdd={() => setAdding(kind.id)}
					onCancelAdd={() => setAdding(null)}
					onChanged={() => {
						setAdding(null);
						reload();
					}}
					onError={setError}
				/>
			))}

			{retired.length > 0 && (
				<section className="rounded-lg border p-4">
					<h2 className="text-lg font-semibold">No longer in force</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						Kept readable: anything the log cited while these stood still
						resolves against them.
					</p>
					<ul className="mt-3 space-y-2">
						{retired.map((agreement) => (
							<li key={agreement.id}>
								<AgreementRow
									agreement={agreement}
									now={now}
									canAuthor={authorsKind(kinds, agreement.kind, selfRole)}
									retired
									onChanged={reload}
									onError={setError}
								/>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

/** One kind and its terms, with the authoring control only its authors see. */
function KindSection({
	kind,
	agreements,
	now,
	canAuthor,
	adding,
	onAdd,
	onCancelAdd,
	onChanged,
	onError,
}: {
	kind: AgreementKind;
	agreements: VersionedAgreement[];
	now: number;
	canAuthor: boolean;
	adding: boolean;
	onAdd: () => void;
	onCancelAdd: () => void;
	onChanged: () => void;
	onError: (message: string) => void;
}) {
	// A kind neither member authors is readable, never an error — that is how a
	// `sub`-only kind behaves in a couple with no sub (ADR 0003's dormancy).
	if (agreements.length === 0 && !canAuthor) return null;

	return (
		<section className="rounded-lg border p-4">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-lg font-semibold">{kind.label}</h2>
				{canAuthor && !adding && (
					<Button size="sm" onClick={onAdd}>
						Add {kind.label.toLowerCase()}
					</Button>
				)}
			</div>

			{adding && (
				<AgreementForm
					submitLabel={`Add ${kind.label.toLowerCase()}`}
					onSubmit={(name, text, effective_from) =>
						createAgreement({ kind: kind.id, name, text, effective_from })
					}
					onDone={onChanged}
					onCancel={onCancelAdd}
					onError={onError}
				/>
			)}

			{agreements.length === 0 && !adding && (
				<p className="mt-2 text-sm text-muted-foreground">Nothing yet.</p>
			)}

			<ul className="mt-3 space-y-2">
				{agreements.map((agreement) => (
					<li key={agreement.id}>
						<AgreementRow
							agreement={agreement}
							now={now}
							canAuthor={canAuthor}
							onChanged={onChanged}
							onError={onError}
						/>
					</li>
				))}
			</ul>
		</section>
	);
}

/** One term: what it says now, its history, and its author's controls. */
function AgreementRow({
	agreement,
	now,
	canAuthor,
	retired = false,
	onChanged,
	onError,
}: {
	agreement: VersionedAgreement;
	now: number;
	canAuthor: boolean;
	/** Already retired: still its author's to delete, never to revise or re-retire. */
	retired?: boolean;
	onChanged: () => void;
	onError: (message: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [armed, setArmed] = useState<"retire" | "delete" | null>(null);
	const [busy, setBusy] = useState(false);

	// What it says *now*; an announced change dated ahead governs nothing yet, so
	// the row reads the version in force rather than the latest one written.
	const current = agreementEffectiveAt(agreement, now);
	const latest = latestAgreementVersion(agreement);
	const announced = latest.effective_from > now ? latest : null;

	async function run(action: () => Promise<unknown>) {
		setBusy(true);
		try {
			await action();
			setArmed(null);
			setEditing(false);
			onChanged();
		} catch (err) {
			onError(err instanceof Error ? err.message : "That didn't work.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-md border px-3 py-2">
			<div className="flex items-start justify-between gap-3">
				<button
					type="button"
					className="min-w-0 flex-1 text-left"
					onClick={() => setOpen((o) => !o)}
				>
					<span className="font-medium">{current?.name ?? latest.name}</span>
					{announced && (
						<span className="ml-2 text-xs text-muted-foreground">
							changes soon
						</span>
					)}
				</button>
				{canAuthor && !retired && !editing && armed === null && (
					<div className="flex shrink-0 gap-2">
						<Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
							Edit
						</Button>
						<Button
							size="xs"
							variant="ghost"
							onClick={() => setArmed("retire")}
						>
							Retire
						</Button>
					</div>
				)}
				{armed === "retire" && (
					<InlineConfirm
						label="Yes, retire"
						busy={busy}
						onConfirm={() => run(() => retireAgreement(agreement.id))}
						onCancel={() => setArmed(null)}
					/>
				)}
				{armed === "delete" && (
					<InlineConfirm
						label="Yes, delete"
						busy={busy}
						onConfirm={() => run(() => deleteAgreement(agreement.id))}
						onCancel={() => setArmed(null)}
					/>
				)}
			</div>

			{current?.text && (
				<p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
					{current.text}
				</p>
			)}

			{editing && (
				<AgreementForm
					initialName={current?.name ?? latest.name}
					initialText={current?.text ?? latest.text}
					submitLabel="Save change"
					onSubmit={(name, text, effective_from) =>
						reviseAgreement(agreement.id, { name, text, effective_from })
					}
					onDone={onChanged}
					onCancel={() => setEditing(false)}
					onError={onError}
				/>
			)}

			{open && (
				<div className="mt-2 border-t pt-2">
					<h3 className="text-xs font-medium text-muted-foreground">History</h3>
					<ul className="mt-1 space-y-1 text-xs text-muted-foreground">
						{[...agreement.versions]
							.sort((a, b) => b.effective_from - a.effective_from)
							.map((version) => (
								<li key={version.effective_from}>
									<span className="tabular-nums">
										{new Date(version.effective_from).toLocaleDateString()}
									</span>
									{" — "}
									{version.retired ? "retired" : version.name}
									{version.effective_from > now && " (not yet in force)"}
								</li>
							))}
					</ul>
					{canAuthor && armed === null && (
						<Button
							size="xs"
							variant="ghost"
							className="mt-2"
							onClick={() => setArmed("delete")}
						>
							{retired ? "Delete for good" : "Delete instead"}
						</Button>
					)}
					{canAuthor && (
						<p className="mt-1 text-xs text-muted-foreground">
							Deleting only works while nothing in the log has cited this —
							otherwise retiring is as far as it goes, so the record keeps what
							you were held to.
						</p>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Local midnight on a `YYYY-MM-DD` from a date input, or undefined for blank.
 *
 * Local, not UTC: a term takes force on the couple's day, and parsing the string
 * directly would land it at UTC midnight — hours early or late depending on where
 * they are, which is exactly the kind of quiet wrongness a dated term must not
 * have.
 */
function startOfLocalDay(value: string): number | undefined {
	if (!value) return undefined;
	const [y, m, d] = value.split("-").map(Number);
	if (!y || !m || !d) return undefined;
	return new Date(y, m - 1, d).getTime();
}

/** The shared create/revise form — a name, the term itself, and when it starts. */
function AgreementForm({
	initialName = "",
	initialText = "",
	submitLabel,
	onSubmit,
	onDone,
	onCancel,
	onError,
}: {
	initialName?: string;
	initialText?: string;
	submitLabel: string;
	onSubmit: (
		name: string,
		text: string,
		effectiveFrom: number | undefined,
	) => Promise<unknown>;
	onDone: () => void;
	onCancel: () => void;
	onError: (message: string) => void;
}) {
	const [name, setName] = useState(initialName);
	const [text, setText] = useState(initialText);
	const [startsOn, setStartsOn] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit() {
		if (!name.trim()) {
			onError("Give it a short name.");
			return;
		}
		setBusy(true);
		try {
			await onSubmit(name.trim(), text.trim(), startOfLocalDay(startsOn));
			onDone();
		} catch (err) {
			onError(err instanceof Error ? err.message : "That didn't work.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-3 space-y-2">
			<label className="block">
				<span className="text-xs text-muted-foreground">Short name</span>
				<input
					className={`${fieldClass} mt-1`}
					value={name}
					placeholder="e.g. text me when you land"
					onChange={(e) => setName(e.target.value)}
				/>
			</label>
			{/** biome-ignore lint/a11y/noLabelWithoutControl: label wraps the Textarea */}
			<label className="block">
				<span className="text-xs text-muted-foreground">
					What you've agreed
				</span>
				<Textarea
					className="mt-1"
					value={text}
					onChange={(e) => setText(e.target.value)}
				/>
			</label>
			{/* Dating a term ahead is how a change is announced rather than sprung:
			    your partner sees it coming instead of discovering it the moment it
			    binds. It is also the only "draft" this corpus has, on purpose — a
			    private drafting space inside a consent record would be the one thing
			    it shouldn't have. Backdating is refused server-side. */}
			<label className="block">
				<span className="text-xs text-muted-foreground">
					Starts on (leave blank to start now)
				</span>
				<input
					className={`${fieldClass} mt-1`}
					type="date"
					value={startsOn}
					onChange={(e) => setStartsOn(e.target.value)}
				/>
			</label>
			<div className="flex gap-2">
				<Button size="sm" onClick={submit} disabled={busy}>
					{busy ? "…" : submitLabel}
				</Button>
				<Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
