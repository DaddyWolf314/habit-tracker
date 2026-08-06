import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { fieldClass } from "#/components/ui/field.ts";
import { Input } from "#/components/ui/input.tsx";
import {
	ackRewardChanges,
	createRewardItem,
	deleteRewardItem,
	getRoles,
	listCounters,
	listRewardItems,
	retireRewardItem,
	reviseRewardItem,
} from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import { LIVE_REFRESH_MS, useLiveRefresh } from "#/lib/use-live-refresh.ts";
import type { Counter } from "#/shared/counters.ts";
import {
	affordable,
	authorsRewardItem,
	latestRewardItemVersion,
	type RewardItemVersion,
	rewardItemEffectiveAt,
	type VersionedRewardItem,
} from "#/shared/rewards.ts";
import type { Role } from "#/shared/roles.ts";

/**
 * The reward store (#194, ADR 0017) — the catalogue, what each item costs, and
 * what the balance covers right now.
 *
 * **One screen for both partners, not two.** The sub sees what they are saving
 * toward and the dom sees the same list with the authoring controls attached,
 * for the reason ADR 0015 gives for rendering rungs identically to both: the
 * store is a set of terms the couple agreed, and concealing an agreed term's
 * state from the person it binds would make the consent record asymmetric in the
 * one direction it must never be.
 *
 * It is reached from Today and Settings rather than from the tab bar. Browsing
 * the store is a daily act and Today carries the affordability line that leads
 * here; *authoring* one is the rare act #123's test sends to Settings, and a
 * fifth tab would take a phone-width bar past what its labels fit in.
 */
export function RewardsView() {
	const [items, setItems] = useState<VersionedRewardItem[]>([]);
	const [counters, setCounters] = useState<Counter[]>([]);
	const [selfId, setSelfId] = useState<string | null>(null);
	const [selfRole, setSelfRole] = useState<Role | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const [{ rewards }, { counters }, roles] = await Promise.all([
			listRewardItems(),
			listCounters(),
			getRoles(),
		]);
		setItems(rewards);
		setCounters(counters);
		// The authoring controls are gated on the same per-member question the
		// server asks (`authorsRewardItem`), not on "am I the dom": a switch authors
		// too, and the item's subject is what decides.
		const self = roles.members.find((member) => member.is_self);
		setSelfId(self?.member_id ?? null);
		setSelfRole(self?.role ?? null);
	}, []);

	const reload = useCallback(async () => {
		try {
			await refresh();
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Couldn't load the rewards.",
			);
		}
	}, [refresh]);

	useEffect(() => {
		if (hasIdentity()) reload();
	}, [reload]);

	// Acknowledging the partner's store changes belongs here, where the prices
	// themselves are — the same placement the Agreements screen gives the corpus
	// ack. Landing on Today must not clear news that a price moved: the whole
	// protection ADR 0017 settled on is that the sub *sees* the goalposts move.
	// Gated on the items having arrived, so a first paint with an empty list
	// cannot ack a change the screen never showed.
	const loaded = items.length > 0;
	useEffect(() => {
		if (!loaded) return;
		ackRewardChanges().catch(() => {
			// A failed ack leaves the count up for the next load, which is the right
			// failure: showing it again beats clearing one the server never saw.
		});
	}, [loaded]);

	// The balance moves under the viewer — a rule fires, the partner logs
	// something — and a store showing a stale one would say "affordable" about
	// something that no longer is. Same cadence as every other live surface.
	useLiveRefresh(refresh, {
		intervalMs: LIVE_REFRESH_MS,
		enabled: hasIdentity(),
	});

	const now = Date.now();
	const balances = new Map(counters.map((c) => [c.id, c.value]));
	// Retired items are dropped from the store rather than struck through: they
	// are offered for no new redemption, and every past one still resolves through
	// the version table, which is where that history lives.
	const onOffer = items.filter((item) => {
		const version = rewardItemEffectiveAt(item, now);
		return version !== null && !version.retired;
	});

	return (
		<div className="mx-auto max-w-2xl space-y-4 p-4">
			<header>
				<h1 className="text-xl font-semibold">Rewards</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					What's on offer, what it costs, and what you can afford right now.
				</p>
			</header>

			{error && <p className="text-sm text-destructive">{error}</p>}

			{onOffer.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					Nothing on offer yet. The app ships no rewards — what's offered and
					what it costs is yours to agree.
				</p>
			) : (
				<ul className="space-y-3">
					{onOffer.map((item) => (
						<RewardCard
							key={item.id}
							item={item}
							version={
								rewardItemEffectiveAt(item, now) ??
								latestRewardItemVersion(item)
							}
							balance={balances}
							counters={counters}
							mayAuthor={
								selfId !== null && authorsRewardItem(item, selfId, selfRole)
							}
							onChanged={reload}
						/>
					))}
				</ul>
			)}

			<RewardComposer counters={counters} onCreated={reload} />

			<p className="text-sm">
				<Link to="/today" className="underline">
					Back to Today
				</Link>
			</p>
		</div>
	);
}

/**
 * One item: what it is, what it costs, and — the line the whole screen exists for
 * — whether the currency covers it.
 *
 * The distance to a price is shown rather than hidden when it is out of reach,
 * on the reasoning ADR 0015 gives for showing a rung's distance to both partners.
 * The alternative is a store that silently omits what someone is saving toward,
 * which removes the only surface that names the thing.
 */
function RewardCard({
	item,
	version,
	balance,
	counters,
	mayAuthor,
	onChanged,
}: {
	item: VersionedRewardItem;
	version: RewardItemVersion;
	balance: ReadonlyMap<string, number>;
	counters: Counter[];
	mayAuthor: boolean;
	onChanged: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const value = balance.get(version.currency) ?? 0;
	const covered = affordable(version.price, value);
	const currencyName =
		counters.find((c) => c.id === version.currency)?.name ?? version.currency;

	return (
		<li className="rounded-md border p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-medium">{version.name}</h2>
					{version.terms && (
						<p className="mt-1 text-sm text-muted-foreground">
							{version.terms}
						</p>
					)}
				</div>
				<div className="shrink-0 text-right text-sm">
					<div className="font-medium">
						{version.price} {currencyName}
					</div>
					<div className="text-muted-foreground">
						{covered
							? "You can afford this"
							: `${version.price - value} to go (you have ${value})`}
					</div>
				</div>
			</div>
			<p className="mt-2 text-xs text-muted-foreground">
				{version.requires_grant
					? "Redeeming this asks your partner — the points leave when they say yes."
					: "Self-serve — redeeming this spends the points straight away."}
			</p>
			{mayAuthor && (
				<div className="mt-3 flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={() => setEditing((open) => !open)}
					>
						{editing ? "Cancel" : "Edit"}
					</Button>
					{/* Retiring is the real "remove": it keeps every version readable and
					    every past redemption resolvable. A hard delete is offered too,
					    and the server accepts it only for an item nothing has redeemed. */}
					<Button
						size="sm"
						variant="outline"
						onClick={() => retireRewardItem(item.id).then(onChanged)}
					>
						Retire
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => deleteRewardItem(item.id).then(onChanged)}
					>
						Delete
					</Button>
				</div>
			)}
			{editing && (
				<RewardForm
					counters={counters}
					initial={version}
					submitLabel="Save"
					// A revise appends a version — it never overwrites — so the sub is
					// told the price moved and what was already redeemed keeps its price.
					note="Changing the price appends a version and tells your partner. What's already been redeemed keeps what it cost."
					onSubmit={(input) =>
						reviseRewardItem(item.id, input).then(() => {
							setEditing(false);
							onChanged();
						})
					}
				/>
			)}
		</li>
	);
}

/** The dom's "add a reward" form, folded away until asked for. */
function RewardComposer({
	counters,
	onCreated,
}: {
	counters: Counter[];
	onCreated: () => void;
}) {
	const [open, setOpen] = useState(false);

	if (!open) {
		return (
			<Button variant="outline" onClick={() => setOpen(true)}>
				Add a reward
			</Button>
		);
	}
	return (
		<div className="rounded-md border p-4">
			<h2 className="font-medium">Add a reward</h2>
			<RewardForm
				counters={counters}
				submitLabel="Add"
				onSubmit={(input) =>
					createRewardItem(input).then(() => {
						setOpen(false);
						onCreated();
					})
				}
			/>
			<div className="mt-3">
				<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

/**
 * The authoring form, shared by create and revise so the two can never offer
 * different fields — a revise that dropped `requires_grant` would silently reset
 * it to the schema default on every edit.
 */
function RewardForm({
	counters,
	initial,
	submitLabel,
	note,
	onSubmit,
}: {
	counters: Counter[];
	initial?: RewardItemVersion;
	submitLabel: string;
	note?: string;
	onSubmit: (input: {
		name: string;
		terms: string;
		currency: string;
		price: number;
		requires_grant: boolean;
	}) => Promise<unknown>;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [terms, setTerms] = useState(initial?.terms ?? "");
	const [currency, setCurrency] = useState(
		initial?.currency ?? counters[0]?.id ?? "",
	);
	const [price, setPrice] = useState(String(initial?.price ?? ""));
	const [requiresGrant, setRequiresGrant] = useState(
		initial?.requires_grant ?? true,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = useId();

	const priceValue = Number(price);
	const valid =
		name.trim() !== "" &&
		currency !== "" &&
		price !== "" &&
		Number.isInteger(priceValue) &&
		priceValue >= 0;

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			await onSubmit({
				name: name.trim(),
				terms: terms.trim(),
				currency,
				price: priceValue,
				requires_grant: requiresGrant,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't save that.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-3 space-y-3">
			{note && <p className="text-xs text-muted-foreground">{note}</p>}
			<label className="block text-sm" htmlFor={`${ids}-name`}>
				<span className="mb-1 block">What is it?</span>
				<Input
					id={`${ids}-name`}
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="An hour of your undivided attention"
				/>
			</label>
			<label className="block text-sm" htmlFor={`${ids}-terms`}>
				<span className="mb-1 block">Terms</span>
				<Input
					id={`${ids}-terms`}
					value={terms}
					onChange={(e) => setTerms(e.target.value)}
					placeholder="What it means, in your words"
				/>
			</label>
			<label className="block text-sm" htmlFor={`${ids}-currency`}>
				<span className="mb-1 block">Priced in</span>
				{/* The shared field height, never a local copy (#147). */}
				<select
					id={`${ids}-currency`}
					className={fieldClass}
					value={currency}
					onChange={(e) => setCurrency(e.target.value)}
				>
					{counters.map((counter) => (
						<option key={counter.id} value={counter.id}>
							{counter.name}
						</option>
					))}
				</select>
			</label>
			<label className="block text-sm" htmlFor={`${ids}-price`}>
				<span className="mb-1 block">Price</span>
				<Input
					id={`${ids}-price`}
					inputMode="numeric"
					value={price}
					onChange={(e) => setPrice(e.target.value)}
					placeholder="40"
				/>
			</label>
			<label
				className="flex items-center gap-2 text-sm"
				htmlFor={`${ids}-grant`}
			>
				<input
					id={`${ids}-grant`}
					type="checkbox"
					checked={requiresGrant}
					onChange={(e) => setRequiresGrant(e.target.checked)}
				/>
				{/* Defaults to yes (ADR 0017). "An hour of your undivided attention"
				    cannot be self-serve because the dom has to turn up; "skip today's
				    ritual" needs no ceremony. The item says which kind of thing it is. */}
				<span>Redeeming this needs you to say yes</span>
			</label>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<Button disabled={!valid || busy} onClick={submit}>
				{busy ? "Saving…" : submitLabel}
			</Button>
		</div>
	);
}
