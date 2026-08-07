import { z } from "zod";
import {
	forwardOnlyRefusal,
	latestVersionOf,
	versionInForceAt,
} from "./effective-dating.ts";
import type { Role } from "./roles.ts";

/**
 * The reward store (ADR 0017) — priced items a **Currency** is spent on. Pure and
 * dependency-free like `agreements.ts`, which it is shaped after, so the Durable
 * Object and the UI reach the same answers through the same functions.
 *
 * A reward item is **not a rung**. A rung announces at a threshold; a reward is
 * *chosen* and *priced*, and that single difference is the whole ADR: mirroring
 * the ladder would make saving up impossible, because the small reward would fire
 * at 20 while the sub is banking toward the big one at 100.
 *
 * Three things live here that nothing else may re-derive:
 *
 *  - **Resolution.** A redemption's `reward_ref` is a **citing ref**, so it reads
 *    {@link rewardItemEffectiveAt} at the redeeming event's `occurred_at` — the
 *    same clock an `infraction`'s `rule_ref` uses, and for the same reason. No
 *    fourth clock appears; a reward item is a term, and terms resolve where the
 *    person was bound.
 *  - **Authorship.** {@link validateRewardWrite} is the single gate for every
 *    write, shaped after `validateAgreementWrite` including the `forbidden` flag
 *    that separates a 403 from a 400.
 *  - **Affordability.** {@link pricesCrossed} makes "you can afford this now" a
 *    **Crossing** rather than a second pressure surface (ADR 0017): the store
 *    borrows the ladder's announcement mechanism instead of inventing one.
 */

/** The `ref_kind` a citing ref declares to point at the store. */
export const REWARD_REF_KIND = "reward";

/**
 * The roles that may author a reward item, and the scope that narrows them to a
 * member (ADR 0010, ADR 0017 — "about the sub, authored by the dom").
 *
 * Fixed rather than a per-couple **Agreement kind** row, because a reward item is
 * its own definition kind rather than an entry in the corpus: there is nothing to
 * classify, so there is no kind to carry a list. The scope it borrows is
 * `counterpart` — anyone in the list except the member it is about — which is the
 * same shape `protocol` has, and for the same reason: the person spending the
 * currency must not be able to reprice what they are saving toward.
 */
export const REWARD_AUTHOR_ROLES: readonly Role[] = ["dom", "switch"];

/**
 * One effective-dated revision of an item. Name, terms, currency, price and
 * whether spending it needs a grant all version *together*, so a reprice is never
 * retroactive: a past redemption keeps the price it was quoted, and a rename
 * keeps reading the way it read then (ADR 0009's argument, applied here).
 *
 * `retired` is a version like any other — retiring is effective-dated, not a
 * column flip — so a retired item stays readable and every past citation of it
 * still resolves.
 */
export const rewardItemVersionSchema = z.object({
	effective_from: z.number().int(),
	name: z.string().min(1),
	/** What the couple agreed the item *is* — the prose half, like an Agreement's. */
	terms: z.string(),
	/** The counter this item is priced in (ADR 0015 — each score is its own counter). */
	currency: z.string().min(1),
	/**
	 * What the item costs, in `currency`.
	 *
	 * Non-negative rather than positive, on the reasoning ADR 0015 gave a cap
	 * target of `0`: an item that costs nothing is meaningless rather than
	 * dangerous, and refusing it here would be policing a number the couple is
	 * entitled to write. It is also what the **routed magnitude** demands — a
	 * `by_from` field must be declared whole and `min` at 0 or above, because the
	 * effect's verb carries the direction and a negative price would turn a spend
	 * into a payout.
	 */
	price: z.number().int().nonnegative(),
	/**
	 * Whether spending this needs the dom to grant it (ADR 0017), **defaulting to
	 * yes**.
	 *
	 * Forcing one shape would be false to half the cases: "an hour of your
	 * undivided attention" cannot be self-serve because the dom has to turn up, and
	 * "skip today's ritual" needs no ceremony. Both paths existed already — this
	 * only says which kind of thing the item is.
	 */
	requires_grant: z.boolean().default(true),
	retired: z.boolean().default(false),
});
export type RewardItemVersion = z.infer<typeof rewardItemVersionSchema>;

/**
 * A stable id carrying append-only versions. `subject` sits here rather than on a
 * version and is never written twice, exactly as an Agreement's is (ADR 0010): a
 * versioned subject would let a revision move an item to its author and own it
 * outright, reopening through the version table the invariant the author gate
 * closes.
 */
export const versionedRewardItemSchema = z.object({
	id: z.string().min(1),
	/** The member the item is **about** — who may redeem it. */
	subject: z.string().optional(),
	versions: z.array(rewardItemVersionSchema).min(1),
});
export type VersionedRewardItem = z.infer<typeof versionedRewardItemSchema>;

/**
 * The version in force at `atMs`. Null before the first version: a citation
 * cannot predate the item, and falling back to the earliest would quote a price
 * that had not been offered yet. A version dated ahead is the announced reprice
 * and governs nothing until it arrives.
 */
export function rewardItemEffectiveAt(
	item: VersionedRewardItem,
	atMs: number,
): RewardItemVersion | null {
	return versionInForceAt(item.versions, atMs) ?? null;
}

/**
 * The last version written, by `effective_from` — not the same as the one in
 * force, since an announced reprice dated ahead is the latest while governing
 * nothing yet. Retiring reads this, because a retirement has to land after
 * *every* existing version or a pending reprice would resolve past it and quietly
 * un-retire the item.
 */
export function latestRewardItemVersion(
	item: VersionedRewardItem,
): RewardItemVersion {
	return latestVersionOf(item.versions);
}

/**
 * The items a citing ref may offer at `atMs`: those in force and not retired —
 * the Agreement rule, deliberately unchanged. A retired item leaves the store
 * while every past redemption of it still resolves through
 * {@link rewardItemEffectiveAt}, so a rebuild reproduces what was spent.
 */
export function rewardItemsInForce(
	items: VersionedRewardItem[],
	atMs: number,
): VersionedRewardItem[] {
	return items.filter((item) => {
		const version = rewardItemEffectiveAt(item, atMs);
		return version !== null && !version.retired;
	});
}

/**
 * The metadata keys on a type that cite a reward item — every `ref` field
 * declaring `ref_kind: "reward"`.
 *
 * Derived from the schema rather than a hardcoded key list, exactly as
 * `agreementRefKeys` is: a field declaring the ref kind *is* the statement "this
 * key names an item", so a couple's own type citing the store is covered the day
 * someone writes it.
 */
export function rewardRefKeys(type: {
	metadata: Record<string, { kind: string; ref_kind?: string }>;
}): string[] {
	return Object.entries(type.metadata)
		.filter(([, f]) => f.kind === "ref" && f.ref_kind === REWARD_REF_KIND)
		.map(([key]) => key);
}

/**
 * How a redemption's citation reads: the item's name **as it stood when the
 * redemption happened**, and the current one beside it when they differ — the
 * same two halves `describeCitation` renders for an Agreement, for the same two
 * reasons. Returns null when the id names nothing the couple holds.
 */
export function describeRewardCitation(
	items: VersionedRewardItem[],
	id: string,
	occurredAt: number,
	now: number,
): string | null {
	const item = items.find((i) => i.id === id);
	if (!item) return null;
	const then = rewardItemEffectiveAt(item, occurredAt);
	const current =
		rewardItemEffectiveAt(item, now) ?? latestRewardItemVersion(item);
	const thenName = then?.name ?? latestRewardItemVersion(item).name;
	return thenName === current.name
		? thenName
		: `${thenName} (now: ${current.name})`;
}

// ── Affordability is a crossing (ADR 0017) ───────────────────────────────────

/**
 * The items a currency move from `from` to `to` made affordable, cheapest first.
 *
 * Deliberately the **same** predicate {@link rungsCrossed} applies to a rung:
 * upward only, open on the low side and closed on the high. ADR 0017 asks for the
 * store's affordability signal to *be* a crossing rather than a second mechanism,
 * and "the same predicate" is the only reading of that which cannot drift — a
 * price the counter lands exactly on is affordable, and a later move starting
 * there does not announce it twice.
 *
 * `items` are the versions already resolved for the moment of the move; this
 * folds what it is handed and does not resolve a clock of its own.
 */
export function pricesCrossed(
	items: readonly { id: string; price: number }[],
	from: number,
	to: number,
): { id: string; price: number }[] {
	if (to <= from) return [];
	return items
		.filter((item) => item.price > from && item.price <= to)
		.sort((a, b) => a.price - b.price);
}

/** Whether a currency standing at `value` covers `price`. The store's one test. */
export function affordable(price: number, value: number): boolean {
	return value >= price;
}

/**
 * Why a spend cannot land, or null when the currency covers it.
 *
 * Asked **at the moment the points move** and nowhere else — which is the append
 * for a self-serve item and the *grant* for one that needs adjudicating. That
 * placement is the whole of it: `applyCounterOp` has no floor, so a spend the
 * currency cannot cover would drive it negative and the ladder would then
 * announce crossings climbing back out of the hole.
 *
 * Checking it at the grant rather than at the request is what makes it honest.
 * An earlier revision checked at append for both paths, which protected only the
 * self-serve case while reading as a general guard: for a grant-requiring item
 * the value can fall between the request and the ruling, and two individually
 * affordable pending redemptions can both be granted. It also compared a price
 * read at `occurred_at` against the value *now* — two clocks for no reason. Here
 * the pair is exactly the one the decrement itself uses: the price the event was
 * stamped with, against what the counter holds when the effect would apply.
 *
 * A refusal strands nothing. The redemption stays **pending**, so the dom can
 * grant it later once the currency recovers and the sub can still retract it —
 * the same window in which nothing has been spent.
 */
export function spendRefusal(price: number, value: number): string | null {
	return affordable(price, value)
		? null
		: `that costs ${price} and only ${value} is saved up`;
}

/**
 * The items on offer at `atMs` whose price the couple's currency values cover —
 * "what is within reach", folded once so the store screen and Today's panel
 * cannot disagree about what that means.
 *
 * Shared for the reason `counterValuesOf` is: two surfaces answering the same
 * question their own way is how one ends up saying a thing is affordable while
 * the other doesn't. `values` is the pair both already hold (`{id, value}` off a
 * `Counter`), not either whole type.
 */
export function affordableItems(
	items: VersionedRewardItem[],
	values: readonly { id: string; value: number }[],
	atMs: number,
): VersionedRewardItem[] {
	const byId = new Map(values.map((counter) => [counter.id, counter.value]));
	return rewardItemsInForce(items, atMs).filter((item) => {
		const version = rewardItemEffectiveAt(item, atMs);
		return (
			version !== null &&
			affordable(version.price, byId.get(version.currency) ?? 0)
		);
	});
}

// ── The redemption event (ADR 0017) ──────────────────────────────────────────

/**
 * The pack's redemption type and the three keys the server owns on it.
 *
 * Named here rather than derived from the schema, unlike {@link rewardRefKeys},
 * because the pack rule that spends the currency names these same keys in its
 * `counter_from` and `by_from` — so they are pack vocabulary either way, and one
 * place to read beats a marker that could disagree with the rule beside it.
 */
export const REDEMPTION_TYPE = "redemption";
/** The citing ref naming the item being redeemed. */
export const REDEMPTION_REWARD_KEY = "reward_ref";
/** Where the server stamps the quoted price; the rule routes it as the magnitude. */
export const REDEMPTION_PRICE_KEY = "price";
/** Where the server stamps the currency; the rule routes it as the target counter. */
export const REDEMPTION_CURRENCY_KEY = "currency";
/** The awaited key the dom rules on — and which a self-serve item arrives with set. */
export const REDEMPTION_GRANTED_KEY = "granted";

/** What the server stamps onto a redemption, or why it refused the input. */
export type StampOutcome =
	| { ok: true; metadata: Record<string, string | number | boolean> }
	| { ok: false; error: string };

/**
 * Stamps the price, the currency, and — for a self-serve item — the grant onto a
 * redemption's metadata, from the item version in force at its `occurred_at`.
 *
 * **A client may never supply any of the three**, under exactly the discipline
 * ADR 0005 applies to a minted ref: a caller that thinks it owns the price needs
 * to hear that it doesn't, rather than have its number silently overwritten.
 *
 * The price is put *in the event* because a rule cannot read one off a definition
 * — that is computing, and rules route. Raise the price next month and last
 * month's redemption still says what it actually cost, where a rebuild finds it.
 * The currency rides along for the same reason and is not a second decision: the
 * rule can no more read the item's counter than it can read its price.
 *
 * `granted` is stamped only when the item is **self-serve**, and that single
 * asymmetry is the whole of the grant model. It is the `quality` precedent
 * exactly: a key that arrives set resolves its own **awaiting** entry, so a
 * self-serve redemption never lands pending and the spend applies at append,
 * while a grant-requiring one sits in the queue until the dom rules and the spend
 * rides the `unset → set` transition #184 identified as the only always-safe one.
 */
export function stampRedemption(
	metadata: Record<string, string | number | boolean>,
	version: RewardItemVersion,
): StampOutcome {
	for (const key of [
		REDEMPTION_PRICE_KEY,
		REDEMPTION_CURRENCY_KEY,
		REDEMPTION_GRANTED_KEY,
	]) {
		if (metadata[key] !== undefined) {
			return { ok: false, error: `${key} is assigned by the server` };
		}
	}
	const stamped: Record<string, string | number | boolean> = {
		...metadata,
		[REDEMPTION_PRICE_KEY]: version.price,
		[REDEMPTION_CURRENCY_KEY]: version.currency,
	};
	if (!version.requires_grant) stamped[REDEMPTION_GRANTED_KEY] = true;
	return { ok: true, metadata: stamped };
}

// ── Authoring (ADR 0010's axes, ADR 0017's corpus-grade treatment) ───────────

/**
 * Whether `memberId` may move this item — revise or retire it.
 *
 * The `counterpart` question, asked directly: are you in the author list, and is
 * this not about you? The second half is what stops the sub repricing what they
 * are saving toward, and it is the same guard that stops the bound party
 * rewriting their own protocol.
 *
 * An item with **no subject** is authored by nobody — the residual state an item
 * written before a second member joined would be in. It is retire-only rather
 * than bricked, exactly as a subjectless Agreement is
 * ({@link mayRetireRewardItem}).
 */
export function authorsRewardItem(
	item: Pick<VersionedRewardItem, "subject">,
	memberId: string,
	role: Role | null,
): boolean {
	if (role === null || !REWARD_AUTHOR_ROLES.includes(role)) return false;
	if (item.subject === undefined) return false;
	return item.subject !== memberId;
}

/** Whether `memberId` may retire this item — a superset of {@link authorsRewardItem}. */
export function mayRetireRewardItem(
	item: Pick<VersionedRewardItem, "subject">,
	memberId: string,
	role: Role | null,
): boolean {
	if (authorsRewardItem(item, memberId, role)) return true;
	return (
		item.subject === undefined &&
		role !== null &&
		REWARD_AUTHOR_ROLES.includes(role)
	);
}

/**
 * The authoring payloads, shared so the route parses exactly what the DO stores.
 * `effective_from` is optional and defaults to now at the write site; supplying a
 * future one is how a reprice is *announced* rather than sprung — the same reason
 * ADR 0006 has no draft state, and it matters more here, because a sub banking
 * toward a price is relying on it holding.
 */
export const createRewardItemInputSchema = z.object({
	name: z.string().min(1),
	terms: z.string(),
	currency: z.string().min(1),
	price: z.number().int().nonnegative(),
	requires_grant: z.boolean().default(true),
	effective_from: z.number().int().optional(),
});
export type CreateRewardItemInput = z.infer<typeof createRewardItemInputSchema>;
export type CreateRewardItemBody = z.input<typeof createRewardItemInputSchema>;

export const reviseRewardItemInputSchema = createRewardItemInputSchema;
export type ReviseRewardItemInput = z.infer<typeof reviseRewardItemInputSchema>;

/** Every write the store accepts. One shape in, one validation gate. */
export type RewardWrite =
	| {
			op: "create";
			name: string;
			currency: string;
			price: number;
			effective_from?: number;
	  }
	| {
			op: "revise";
			id: string;
			name: string;
			currency: string;
			price: number;
			effective_from?: number;
	  }
	/**
	 * The only removal the store has. There is deliberately **no hard delete**,
	 * where the corpus has one: ADR 0017 lists what a store does as items being
	 * "added, retired, and repriced", and a redemption has to keep resolving what
	 * it bought. An item nothing has redeemed is no exception worth a second write
	 * path — retiring already takes it off the shelf.
	 */
	| { op: "retire"; id: string };

export interface RewardContext {
	/** The actor's resolved role; null before mutual confirmation. */
	role: Role | null;
	/** The actor's member id — authorship is per-member (ADR 0010). */
	memberId: string;
	/**
	 * Every member id in the couple, for deriving the `counterpart` subject on a
	 * create. A shorter list is what makes a create refusable rather than
	 * subjectless.
	 */
	memberIds: readonly string[];
	/** Now, so a version cannot be dated into the past. */
	now: number;
	items: VersionedRewardItem[];
	/** The counter ids the couple holds — an item must be priced in a real one. */
	currencies: ReadonlySet<string>;
}

export type RewardValidation =
	| { ok: true }
	| { ok: false; error: string; forbidden?: boolean; not_found?: boolean };

const deny = (
	error: string,
	flags: { forbidden?: boolean; not_found?: boolean } = {},
): RewardValidation => ({ ok: false, error, ...flags });

/**
 * Forward-only, through the shared rule (`effective-dating.ts`). What it buys
 * here is what makes the store honest rather than theatre: a version dated into
 * the past would re-price a redemption already made, which is the one thing the
 * stamped price exists to prevent, reached from the other direction.
 */
function checkEffectiveFrom(
	proposed: number | undefined,
	existing: RewardItemVersion[],
	now: number,
): RewardValidation {
	const refusal = forwardOnlyRefusal(proposed, existing, now, "a reward");
	return refusal === null ? { ok: true } : deny(refusal);
}

/**
 * Validates a proposed write. First failure wins.
 *
 * The gate is narrower than the corpus's because the store has no kinds to
 * classify: there is one author list and one scope, so the only questions are
 * *may you author at all*, *is this one about you*, and *is the price legal*.
 */
export function validateRewardWrite(
	write: RewardWrite,
	ctx: RewardContext,
): RewardValidation {
	if (write.op === "create") {
		if (ctx.role === null || !REWARD_AUTHOR_ROLES.includes(ctx.role)) {
			return deny("your role doesn't author rewards", { forbidden: true });
		}
		// A reward is about somebody else by construction (`counterpart` scope), so
		// with nobody else there is no coherent item to write. Refusing beats
		// storing a subjectless one, which would be authored by nobody from the
		// moment it existed — the call `createAgreement` makes for a protocol.
		if (!ctx.memberIds.some((id) => id !== ctx.memberId)) {
			return deny("a reward is for your partner, and you don't have one yet");
		}
		return (
			checkCurrency(write.currency, ctx) ??
			checkEffectiveFrom(write.effective_from, [], ctx.now)
		);
	}

	const item = ctx.items.find((i) => i.id === write.id);
	if (!item) return deny("no such reward", { not_found: true });

	// Retiring is open wider than authorship, so it is settled before the author
	// gate: a subjectless item has no author at all, and without this it would be
	// permanently on offer — unrevisable, unretirable, undeletable.
	if (write.op === "retire") {
		if (!mayRetireRewardItem(item, ctx.memberId, ctx.role)) {
			return deny("this isn't yours to retire", { forbidden: true });
		}
		return { ok: true };
	}

	if (!authorsRewardItem(item, ctx.memberId, ctx.role)) {
		return deny(
			item.subject === undefined
				? "this reward predates knowing whose it is — it can be retired, not changed"
				: "this reward isn't yours to change",
			{ forbidden: true },
		);
	}

	return (
		checkCurrency(write.currency, ctx) ??
		checkEffectiveFrom(write.effective_from, item.versions, ctx.now)
	);
}

/**
 * Ensures an item is priced in a counter the couple actually has. Refused at
 * authoring time for the reason every routing failure in this repo is: a price in
 * a currency nobody holds would log a redemption whose decrement quietly moves
 * nothing, and the sub would find out by not being charged.
 */
function checkCurrency(
	currency: string,
	ctx: RewardContext,
): RewardValidation | null {
	return ctx.currencies.has(currency)
		? null
		: deny(`there's no counter called '${currency}' to price this in`);
}

/**
 * The `consent_history` entry kind for each write (ADR 0017). A reprice lands in
 * the consent history beside an Agreement change rather than in the audit log
 * alone, because saving up is a trust property: a sub banking 80 toward a
 * 50-point item is relying on the price holding, and a silent reprice makes the
 * store theatre.
 */
export function rewardChangeKind(op: RewardWrite["op"]): string {
	return `reward_${op}`;
}

/** The `reward_`-namespaced consent kinds, for selecting store changes out. */
export const REWARD_CHANGE_PREFIX = "reward_";
