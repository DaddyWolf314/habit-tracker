import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { InlineConfirm } from "#/components/inline-confirm.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { fieldClass } from "#/components/ui/field.ts";
import {
	columnsClass,
	pageClass,
	pageColumnsClass,
} from "#/components/ui/page.ts";
import { Textarea } from "#/components/ui/textarea.tsx";
import {
	ackAgreementChanges,
	createAgreement,
	deleteAgreement,
	getRoles,
	listAgreementKinds,
	listAgreements,
	listEventTypes,
	listRules,
	retireAgreement,
	reviseAgreement,
	trackAgreement,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import {
	type AgreementKind,
	type AuthorScope,
	agreementEffectiveAt,
	agreementScope,
	authorsAgreement,
	authorsKind,
	latestAgreementVersion,
	mayRetireAgreement,
	type VersionedAgreement,
} from "#/shared/agreements.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { RoleMember } from "#/shared/identity.ts";
import type { Role } from "#/shared/roles.ts";
import type { Rule } from "#/shared/rules.ts";
import {
	countingTypeFor,
	isTracked,
	type ScaffoldPlan,
	scaffoldPlan,
} from "#/shared/scaffold.ts";

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
	// What already tracks a term is derived from the rules, since ADR 0006 keeps
	// no link — the rule *is* the record that tracking happened.
	const [rules, setRules] = useState<Rule[]>([]);
	// Which type can count a kind is derived, not assumed — the same derivation
	// the server makes, so the preview cannot describe a different plan (#121).
	const [types, setTypes] = useState<EventType[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState<string | null>(null);

	const load = useCallback(async () => {
		const [kindRes, agreementRes, roleRes, ruleRes, typeRes] =
			await Promise.all([
				listAgreementKinds(),
				listAgreements(),
				getRoles(),
				listRules(),
				listEventTypes(),
			]);
		setKinds(kindRes.kinds);
		setAgreements(agreementRes.agreements);
		setMembers(roleRes.members);
		setRules(ruleRes.rules);
		setTypes(typeRes.types);
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
		if (!hasIdentity()) return;
		// Acknowledge on arrival: this screen *is* the content behind the count, so
		// having read it is what "seen" means. A failed ack just leaves the notice
		// up next time — showing it twice is the right failure, marking a change
		// seen that never reached the server is not.
		reload().then(() => ackAgreementChanges().catch(() => {}));
	}, [reload]);

	const selfRole = (members.find((m) => m.is_self)?.role ??
		null) as Role | null;
	// Authorship is per-member since ADR 0010, so the screen needs the viewer's id
	// and not only their role. Empty before `getRoles` lands, which authors nothing
	// — the same floor an unresolved role already had.
	const selfId = members.find((m) => m.is_self)?.member_id ?? "";

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

	return (
		// A term is prose that binds, so the *measure* is what has to be protected
		// here — not the column. Splitting the kind sections into two at `lg` keeps
		// a term at about the width it already had while the page stops being a
		// strip; widening the single column instead would have done the reverse.
		<div className={`${pageColumnsClass} space-y-4`}>
			<h1 className="text-2xl font-bold lg:text-3xl">Agreements</h1>
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

			<div className={columnsClass}>
				{kinds.map((kind) => (
					<KindSection
						key={kind.id}
						kind={kind}
						kinds={kinds}
						agreements={live.filter((a) => a.kind === kind.id)}
						now={now}
						canAuthor={authorsKind(kinds, kind.id, selfRole)}
						selfId={selfId}
						selfRole={selfRole}
						rules={rules}
						types={types}
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
			</div>

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
									canChange={authorsAgreement(
										kinds,
										agreement,
										selfId,
										selfRole,
									)}
									canRetire={false}
									// A retired term is the case the label matters most for: its
									// only control is Delete, so a dom expanding their partner's
									// retired limit would otherwise get no control and nothing
									// saying why.
									whose={whoseTerm(
										agreementScope(kinds, agreement.kind) ?? "unscoped",
										agreement.subject,
										selfId,
									)}
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

/** Whose a term is, from the viewer's side; null for a kind with no subject. */
type Whose = "yours" | "partner" | "unrecorded";

/**
 * The one phrasing for each state, so a heading and a chip about the same fact
 * cannot drift apart — the discipline `CONTEXT.md` sets for *Auto-closed* ("one
 * word across the sessions panel, the closed-countdown rows, and the trace
 * ledger"), applied to whose a term is.
 */
const WHOSE_COPY: Record<Whose, string> = {
	yours: "Yours",
	partner: "Your partner's",
	unrecorded: "Not recorded",
};

/**
 * Which of the three a term is. Named for the **subject** rather than for
 * ownership: `CONTEXT.md`'s Author scope entry avoids "owner" precisely because
 * the subject is the recorded fact and any notion of owning is derived from it.
 *
 * Null for an `unscoped` kind — a safeword has no subject, so a label would be
 * inventing one.
 */
function whoseTerm(
	scope: AuthorScope,
	subject: string | undefined,
	selfId: string,
): Whose | null {
	if (scope === "unscoped") return null;
	if (subject === undefined) return "unrecorded";
	return subject === selfId ? "yours" : "partner";
}

/** One kind and its terms, with the authoring control only its authors see. */
function KindSection({
	kind,
	kinds,
	agreements,
	now,
	canAuthor,
	selfId,
	selfRole,
	rules,
	types,
	adding,
	onAdd,
	onCancelAdd,
	onChanged,
	onError,
}: {
	kind: AgreementKind;
	/** Every kind, since per-entry authorship resolves through the scope. */
	kinds: AgreementKind[];
	agreements: VersionedAgreement[];
	now: number;
	/** Whether the viewer's role may hold a term of this kind — the Add gate. */
	canAuthor: boolean;
	selfId: string;
	selfRole: Role | null;
	rules: Rule[];
	types: EventType[];
	adding: boolean;
	onAdd: () => void;
	onCancelAdd: () => void;
	onChanged: () => void;
	onError: (message: string) => void;
}) {
	// Whose terms this section holds. One group is the common case and renders no
	// headings at all; a second appears only once the section genuinely contains
	// two people's terms, which is what the widened `limit` kind made possible
	// (ADR 0010). Ordered so the viewer's own come first.
	const groups = useMemo(() => {
		if (kind.author_scope === "unscoped") {
			return [{ subject: undefined, heading: "", agreements }];
		}
		const bySubject = new Map<string | undefined, VersionedAgreement[]>();
		for (const agreement of agreements) {
			const existing = bySubject.get(agreement.subject);
			if (existing) existing.push(agreement);
			else bySubject.set(agreement.subject, [agreement]);
		}
		return [...bySubject.entries()]
			.map(([subject, group]) => ({
				subject,
				heading:
					subject === undefined
						? WHOSE_COPY.unrecorded
						: subject === selfId
							? WHOSE_COPY.yours
							: WHOSE_COPY.partner,
				agreements: group,
			}))
			.sort((a, b) =>
				a.subject === selfId ? -1 : b.subject === selfId ? 1 : 0,
			);
	}, [agreements, kind.author_scope, selfId]);

	// A kind neither member authors is readable, never an error — that is how a
	// `sub`-only kind behaves in a couple with no sub (ADR 0003's dormancy). An
	// empty one still renders while it carries the new-default flag, or the notice
	// #159 exists to raise would be unreachable on exactly the kinds a couple is not
	// in — `rules-view.tsx` has no equivalent gate in front of its badge.
	if (agreements.length === 0 && !canAuthor && !kind.upstream_changed)
		return null;

	return (
		<section className="rounded-lg border p-4">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<h2 className="text-lg font-semibold">{kind.label}</h2>
					{/*
					 * The couple edited who authors this kind, and a later ship changed
					 * the shipped default (#159). Their list still applies — the pack
					 * never overwrites an adopted kind — so this offers the new default
					 * rather than announcing a change that already happened.
					 */}
					{kind.upstream_changed && <Badge tone="accent">new default</Badge>}
				</div>
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

			{groups.map((group) => (
				<div key={group.subject ?? "unrecorded"}>
					{/*
					 * Only once a section actually holds more than one person's terms
					 * (ADR 0010). In a dom+sub couple every protocol is the sub's and the
					 * heading never appears; it shows up where it earns its keep — the
					 * widened Limits section, and a switch+switch couple's protocols.
					 */}
					{groups.length > 1 && (
						<h3 className="mt-3 text-xs font-medium text-muted-foreground">
							{group.heading}
						</h3>
					)}
					<ul className="mt-2 space-y-2">
						{group.agreements.map((agreement) => {
							const canChange = authorsAgreement(
								kinds,
								agreement,
								selfId,
								selfRole,
							);
							return (
								<li key={agreement.id}>
									<AgreementRow
										agreement={agreement}
										now={now}
										canChange={canChange}
										canRetire={mayRetireAgreement(
											kinds,
											agreement,
											selfId,
											selfRole,
										)}
										// Said once per view, not twice: when the section is grouped
										// the heading above already carries this, and repeating it on
										// every row under it is noise.
										whose={
											groups.length > 1
												? null
												: whoseTerm(
														kind.author_scope,
														agreement.subject,
														selfId,
													)
										}
										// Only a ritual has something to count, and only while
										// nothing already counts it (#121). Gated on per-entry
										// authorship, since scaffolding writes automation off
										// somebody's term.
										counting={
											canChange && !isTracked(agreement.id, rules, types)
												? countingTypeFor(kind.id, types)
												: null
										}
										onChanged={onChanged}
										onError={onError}
									/>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</section>
	);
}

/** One term: what it says now, its history, and its author's controls. */
function AgreementRow({
	agreement,
	now,
	canChange,
	canRetire,
	whose = null,
	counting = null,
	retired = false,
	onChanged,
	onError,
}: {
	agreement: VersionedAgreement;
	now: number;
	/** May revise, re-kind, delete or track it — authorship of *this* entry. */
	canChange: boolean;
	/**
	 * May retire it, which is deliberately wider (ADR 0010): a scoped entry with no
	 * subject has no author, so retiring is the couple's only way to end it.
	 */
	canRetire: boolean;
	/**
	 * Whose term it is, for a kind that has a subject; null for an `unscoped` one.
	 * Without it, a viewer with no Edit control cannot tell "your role doesn't hold
	 * this kind" from "this one is your partner's" — and the second is the guarantee
	 * ADR 0010 exists to give, so leaving it to a missing button would make it
	 * invisible exactly where it is looked for.
	 */
	whose?: Whose | null;
	/** The type that would count this term, when it can still be tracked. */
	counting?: { type: EventType; refKey: string } | null;
	/** Already retired: still its author's to delete, never to revise or re-retire. */
	retired?: boolean;
	onChanged: () => void;
	onError: (message: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [armed, setArmed] = useState<"retire" | "delete" | null>(null);
	const [busy, setBusy] = useState(false);
	// Per-row: the corpus renders many of these, and `aria-controls` has to name
	// this row's history rather than some other row's (#148).
	const historyId = useId();

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
					aria-expanded={open}
					aria-controls={historyId}
					onClick={() => setOpen((o) => !o)}
				>
					<span className="font-medium">{current?.name ?? latest.name}</span>
					{whose && (
						<span className="ml-2 align-middle">
							<Badge tone={whose === "yours" ? "accent" : "neutral"}>
								{WHOSE_COPY[whose]}
							</Badge>
						</span>
					)}
					{announced && (
						<span className="ml-2 text-xs text-muted-foreground">
							changes soon
						</span>
					)}
				</button>
				{!retired && !editing && armed === null && (
					<div className="flex shrink-0 gap-2">
						{canChange && (
							<Button
								size="xs"
								variant="ghost"
								onClick={() => setEditing(true)}
							>
								Edit
							</Button>
						)}
						{canRetire && (
							<Button
								size="xs"
								variant="ghost"
								onClick={() => setArmed("retire")}
							>
								Retire
							</Button>
						)}
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

			{open && counting && !retired && (
				<TrackOffer
					agreement={agreement}
					name={current?.name ?? latest.name}
					counting={counting}
					onDone={onChanged}
					onError={onError}
				/>
			)}

			{open && (
				<div id={historyId} className="mt-2 border-t pt-2">
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
					{canChange && armed === null && (
						<Button
							size="xs"
							variant="ghost"
							className="mt-2"
							onClick={() => setArmed("delete")}
						>
							{retired ? "Delete for good" : "Delete instead"}
						</Button>
					)}
					{canChange && (
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
	// The form renders once per agreement row being edited, so the ids have to be
	// per-instance or two open editors would collide on them (#148).
	const ids = useId();

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
			<label className="block" htmlFor={`${ids}-name`}>
				<span className="text-xs text-muted-foreground">Short name</span>
				<input
					id={`${ids}-name`}
					className={`${fieldClass} mt-1`}
					value={name}
					placeholder="e.g. text me when you land"
					onChange={(e) => setName(e.target.value)}
				/>
			</label>
			<label className="block" htmlFor={`${ids}-text`}>
				<span className="text-xs text-muted-foreground">
					What you've agreed
				</span>
				<Textarea
					id={`${ids}-text`}
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
			<label className="block" htmlFor={`${ids}-starts-on`}>
				<span className="text-xs text-muted-foreground">
					Starts on (leave blank to start now)
				</span>
				<input
					id={`${ids}-starts-on`}
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

/**
 * "Track this" — the one-time scaffold (#121, stories 34–35).
 *
 * The plan is rendered *before* anything is created, from the same pure function
 * the server builds from, so the confirmation cannot describe something other
 * than what gets made. Three artifacts appearing unannounced in a couple's
 * counters and rules would be exactly the kind of surprise this app avoids
 * elsewhere by showing mechanical fallout up front (§8.4's confirm sheet).
 */
function TrackOffer({
	agreement,
	name,
	counting,
	onDone,
	onError,
}: {
	agreement: VersionedAgreement;
	name: string;
	/** Derived by `countingTypeFor` — the same answer the server reaches. */
	counting: { type: EventType; refKey: string };
	onDone: () => void;
	onError: (message: string) => void;
}) {
	const [preview, setPreview] = useState<ScaffoldPlan | null>(null);
	const [busy, setBusy] = useState(false);

	// Computed, not fetched: both sides build from `scaffoldPlan` over the same
	// derived inputs, so a round trip could only add a way for them to differ.
	function show() {
		setPreview(
			scaffoldPlan({
				agreementId: agreement.id,
				name,
				eventTypeId: counting.type.id,
				refKey: counting.refKey,
			}),
		);
	}

	async function confirm() {
		setBusy(true);
		try {
			await trackAgreement(agreement.id);
			setPreview(null);
			onDone();
		} catch (err) {
			onError(err instanceof Error ? err.message : "Couldn't track that.");
		} finally {
			setBusy(false);
		}
	}

	if (!preview) {
		return (
			<div className="mt-2 border-t pt-2">
				<Button size="xs" variant="outline" onClick={show}>
					Track this
				</Button>
				<p className="mt-1 text-xs text-muted-foreground">
					Counts each time it's done, and keeps a streak.
				</p>
			</div>
		);
	}

	return (
		<div className="mt-2 space-y-2 border-t pt-2 text-xs">
			<p className="font-medium">This will add:</p>
			<ul className="space-y-1 text-muted-foreground">
				<li>a daily counter, “{preview.counter.name}”, with a target of 1</li>
				<li>a streak of it, “{preview.streak.name}”</li>
				<li>a rule counting every “{name}” you log</li>
			</ul>
			<p className="text-muted-foreground">
				They become ordinary counters and an ordinary rule — edit or remove them
				like any other.
			</p>
			<div className="flex gap-2">
				<Button size="xs" onClick={confirm} disabled={busy}>
					{busy ? "…" : "Add them"}
				</Button>
				<Button
					size="xs"
					variant="ghost"
					onClick={() => setPreview(null)}
					disabled={busy}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}
