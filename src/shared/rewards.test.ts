import { describe, expect, it } from "vitest";
import {
	affordable,
	authorsRewardItem,
	latestRewardItemVersion,
	mayRetireRewardItem,
	pricesCrossed,
	REDEMPTION_CURRENCY_KEY,
	REDEMPTION_GRANTED_KEY,
	REDEMPTION_PRICE_KEY,
	REWARD_REF_KIND,
	type RewardItemVersion,
	rewardItemEffectiveAt,
	rewardItemsInForce,
	rewardRefKeys,
	stampRedemption,
	type VersionedRewardItem,
	validateRewardWrite,
} from "./rewards.ts";

/**
 * The reward store (#194, ADR 0017). The unit half — resolution, affordability,
 * stamping and the author gate. The wired half (a price change between quoting
 * and redeeming, a grant that moves points and a refusal that never does, a
 * rebuild reproducing values from stamped prices) lives in `couple-do.test.ts`,
 * because every one of those is a fact about the log rather than about a
 * function.
 */

function version(
	partial: Partial<RewardItemVersion> & { effective_from: number },
): RewardItemVersion {
	return {
		name: "An hour of your undivided attention",
		terms: "",
		currency: "service_points",
		price: 50,
		requires_grant: true,
		retired: false,
		...partial,
	};
}

const ITEM: VersionedRewardItem = {
	id: "rw_1",
	subject: "m_sub",
	versions: [version({ effective_from: 1_000 })],
};

describe("resolution — a citing ref's clock (ADR 0017)", () => {
	it("resolves the version in force at the moment asked for", () => {
		const repriced: VersionedRewardItem = {
			...ITEM,
			versions: [
				version({ effective_from: 1_000, price: 50 }),
				version({ effective_from: 5_000, price: 100 }),
			],
		};
		expect(rewardItemEffectiveAt(repriced, 4_999)?.price).toBe(50);
		expect(rewardItemEffectiveAt(repriced, 5_000)?.price).toBe(100);
	});

	// A citation cannot predate the item. Falling back to the earliest version
	// would quote a price that had not been offered yet.
	it("resolves to nothing before the first version", () => {
		expect(rewardItemEffectiveAt(ITEM, 999)).toBeNull();
	});

	// The distinction retiring depends on: a version dated ahead is the announced
	// reprice, the latest written while governing nothing yet.
	it("distinguishes the latest version from the one in force", () => {
		const announced: VersionedRewardItem = {
			...ITEM,
			versions: [
				version({ effective_from: 1_000, price: 50 }),
				version({ effective_from: 9_000, price: 100 }),
			],
		};
		expect(rewardItemEffectiveAt(announced, 2_000)?.price).toBe(50);
		expect(latestRewardItemVersion(announced).price).toBe(100);
	});
});

describe("candidacy — the Agreement lifecycle, unchanged", () => {
	it("offers an item in force and withholds a retired one", () => {
		const retired: VersionedRewardItem = {
			id: "rw_2",
			subject: "m_sub",
			versions: [
				version({ effective_from: 1_000 }),
				version({ effective_from: 2_000, retired: true }),
			],
		};
		expect(rewardItemsInForce([ITEM, retired], 1_500).map((i) => i.id)).toEqual(
			["rw_1", "rw_2"],
		);
		expect(rewardItemsInForce([ITEM, retired], 2_500).map((i) => i.id)).toEqual(
			["rw_1"],
		);
	});

	// The other half of the same rule, and the one that matters more: a retired
	// item leaves the picker while every past redemption of it still resolves.
	it("still resolves a retired item at a past moment", () => {
		const retired: VersionedRewardItem = {
			id: "rw_2",
			subject: "m_sub",
			versions: [
				version({ effective_from: 1_000, price: 40 }),
				version({ effective_from: 2_000, retired: true }),
			],
		};
		expect(rewardItemEffectiveAt(retired, 1_500)?.price).toBe(40);
	});
});

describe("derived ref keys", () => {
	it("finds every field declaring the reward ref kind", () => {
		expect(
			rewardRefKeys({
				metadata: {
					reward_ref: { kind: "ref", ref_kind: REWARD_REF_KIND },
					rule_ref: { kind: "ref", ref_kind: "agreement" },
					price: { kind: "number" },
				},
			}),
		).toEqual(["reward_ref"]);
	});
});

describe("affordability is a crossing (ADR 0017)", () => {
	// Deliberately the same predicate `rungsCrossed` applies: upward only, open on
	// the low side and closed on the high.
	it("announces a price the move landed exactly on, once", () => {
		const items = [{ id: "rw_1", price: 50 }];
		expect(pricesCrossed(items, 45, 50)).toEqual(items);
		expect(pricesCrossed(items, 50, 60)).toEqual([]);
	});

	it("announces nothing on the way down", () => {
		expect(pricesCrossed([{ id: "rw_1", price: 50 }], 60, 40)).toEqual([]);
	});

	it("announces every price one move passed, cheapest first", () => {
		expect(
			pricesCrossed(
				[
					{ id: "big", price: 100 },
					{ id: "small", price: 20 },
				],
				0,
				100,
			).map((i) => i.id),
		).toEqual(["small", "big"]);
	});

	it("covers a price the value sits exactly on", () => {
		expect(affordable(50, 50)).toBe(true);
		expect(affordable(50, 49)).toBe(false);
	});
});

describe("stamping (ADR 0005's minting discipline, ADR 0017)", () => {
	it("stamps the price and currency from the version in force", () => {
		const out = stampRedemption(
			{ reward_ref: "rw_1" },
			version({
				effective_from: 1_000,
				price: 50,
				currency: "service_points",
			}),
		);
		expect(out).toEqual({
			ok: true,
			metadata: {
				reward_ref: "rw_1",
				[REDEMPTION_PRICE_KEY]: 50,
				[REDEMPTION_CURRENCY_KEY]: "service_points",
			},
		});
	});

	// The whole grant model, in one asymmetry: a self-serve item arrives with its
	// awaited key already set, so it never lands pending — the `quality` precedent.
	it("stamps the grant only for a self-serve item", () => {
		const selfServe = stampRedemption(
			{ reward_ref: "rw_1" },
			version({
				effective_from: 1_000,
				requires_grant: false,
			}),
		);
		expect(selfServe.ok && selfServe.metadata[REDEMPTION_GRANTED_KEY]).toBe(
			true,
		);

		const granted = stampRedemption(
			{ reward_ref: "rw_1" },
			version({
				effective_from: 1_000,
				requires_grant: true,
			}),
		);
		expect(
			granted.ok && granted.metadata[REDEMPTION_GRANTED_KEY],
		).toBeUndefined();
	});

	// Refused rather than overwritten: a caller that thinks it owns the price
	// needs to hear that it doesn't.
	it.each([
		REDEMPTION_PRICE_KEY,
		REDEMPTION_CURRENCY_KEY,
		REDEMPTION_GRANTED_KEY,
	])("refuses a client-supplied %s", (key) => {
		const out = stampRedemption(
			{ reward_ref: "rw_1", [key]: key === REDEMPTION_GRANTED_KEY ? true : 1 },
			version({ effective_from: 1_000 }),
		);
		expect(out).toEqual({
			ok: false,
			error: `${key} is assigned by the server`,
		});
	});
});

describe("authorship — counterpart scope (ADR 0010)", () => {
	it("lets the dom move an item about the sub", () => {
		expect(authorsRewardItem({ subject: "m_sub" }, "m_dom", "dom")).toBe(true);
	});

	// The half that stops the store being theatre from the other direction: the
	// person spending the currency cannot reprice what they are saving toward.
	it("refuses the member the item is about", () => {
		expect(authorsRewardItem({ subject: "m_sub" }, "m_sub", "sub")).toBe(false);
		// Even holding an authoring role — a switch cannot reprice their own.
		expect(authorsRewardItem({ subject: "m_sw" }, "m_sw", "switch")).toBe(
			false,
		);
	});

	it("refuses a role outside the author list, and an unresolved one", () => {
		expect(authorsRewardItem({ subject: "m_sub" }, "m_dom", "sub")).toBe(false);
		expect(authorsRewardItem({ subject: "m_sub" }, "m_dom", null)).toBe(false);
	});

	// A subjectless item is authored by nobody; retiring is the one escape, or it
	// would be permanently on offer.
	it("makes a subjectless item retire-only", () => {
		expect(authorsRewardItem({ subject: undefined }, "m_dom", "dom")).toBe(
			false,
		);
		expect(mayRetireRewardItem({ subject: undefined }, "m_dom", "dom")).toBe(
			true,
		);
	});
});

describe("the write gate", () => {
	const ctx = {
		role: "dom" as const,
		memberId: "m_dom",
		memberIds: ["m_dom", "m_sub"],
		now: 10_000,
		items: [ITEM],
		currencies: new Set(["service_points"]),
		cited: new Set<string>(),
	};

	it("accepts a create in a real currency", () => {
		expect(
			validateRewardWrite(
				{ op: "create", name: "x", currency: "service_points", price: 10 },
				ctx,
			),
		).toEqual({ ok: true });
	});

	// Refused at authoring time for the reason every routing failure here is: a
	// price in a currency nobody holds decrements nothing, and the sub finds out
	// by not being charged.
	it("refuses a price in a currency the couple doesn't hold", () => {
		const result = validateRewardWrite(
			{ op: "create", name: "x", currency: "nope", price: 10 },
			ctx,
		);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.forbidden).toBeUndefined();
	});

	it("refuses a create by a role that doesn't author rewards", () => {
		const result = validateRewardWrite(
			{ op: "create", name: "x", currency: "service_points", price: 10 },
			{ ...ctx, role: "sub", memberId: "m_sub" },
		);
		expect(result).toEqual({
			ok: false,
			error: "your role doesn't author rewards",
			forbidden: true,
		});
	});

	// Forward-only: a backdated reprice would rewrite what a past redemption was
	// resolved against, which is what the stamped price exists to prevent.
	it("refuses a backdated version", () => {
		const result = validateRewardWrite(
			{
				op: "revise",
				id: "rw_1",
				name: "x",
				currency: "service_points",
				price: 10,
				effective_from: 9_000,
			},
			ctx,
		);
		expect(result.ok).toBe(false);
	});

	it("refuses a version landing at or before an existing one", () => {
		const result = validateRewardWrite(
			{
				op: "revise",
				id: "rw_1",
				name: "x",
				currency: "service_points",
				price: 10,
				effective_from: 10_001,
			},
			{
				...ctx,
				items: [{ ...ITEM, versions: [version({ effective_from: 20_000 })] }],
			},
		);
		expect(result.ok).toBe(false);
	});

	// Retiring is the store's only removal (ADR 0017 — items are "added, retired,
	// and repriced"), so it stays available however much history an item has: a
	// redemption keeps resolving what it bought either way.
	it("allows retiring an item something has redeemed", () => {
		expect(validateRewardWrite({ op: "retire", id: "rw_1" }, ctx)).toEqual({
			ok: true,
		});
	});

	it("reports an unknown id as not found", () => {
		expect(validateRewardWrite({ op: "retire", id: "nope" }, ctx)).toEqual({
			ok: false,
			error: "no such reward",
			not_found: true,
		});
	});

	// A counterpart-scoped item is defined relative to somebody else.
	it("refuses a create with nobody to offer it to", () => {
		const result = validateRewardWrite(
			{ op: "create", name: "x", currency: "service_points", price: 10 },
			{ ...ctx, memberIds: ["m_dom"] },
		);
		expect(result.ok).toBe(false);
	});
});
