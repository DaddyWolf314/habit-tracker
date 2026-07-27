import { describe, expect, it } from "vitest";
import {
	type AgreementKind,
	agreementEffectiveAt,
	agreementsInForce,
	authorsKind,
	type VersionedAgreement,
	validateAgreementWrite,
} from "./agreements.ts";

/**
 * The Agreement corpus (ADR 0006, #121). Two properties carry the weight here and
 * both are asserted as external behaviour — given a corpus, an actor and a write,
 * what comes back — never a private field or call order:
 *
 *  - **Resolution at `occurred_at`.** A citation reads the version in force when
 *    the act happened, not when it was logged and not what the terms became. This
 *    is deliberately a different clock from rule versions (ADR 0002, log-time).
 *  - **Authorship cannot be escalated into.** The sub alone authors limits, and
 *    neither role can reach that by editing the kind's author list or by
 *    re-kinding an entry. Structure, not policy.
 */

const KINDS: AgreementKind[] = [
	{ id: "protocol", label: "Protocol", author_permission: ["dom", "switch"] },
	{ id: "ritual", label: "Ritual", author_permission: ["dom", "switch"] },
	{ id: "limit", label: "Limit", author_permission: ["sub"] },
	{
		id: "safeword",
		label: "Safeword",
		author_permission: ["dom", "sub", "switch"],
	},
];

const MAR = 1_700_000_000_000;
const JUN = MAR + 90 * 86_400_000;

function agreement(
	partial: Partial<VersionedAgreement> = {},
): VersionedAgreement {
	return {
		id: "ag_7f3",
		kind: "protocol",
		versions: [
			{
				effective_from: MAR,
				name: "text me when you land",
				text: "Text me when you land.",
				retired: false,
			},
		],
		...partial,
	};
}

/** The two-version shape the ADR's worked example uses. */
const tightened = agreement({
	versions: [
		{
			effective_from: MAR,
			name: "text me when you land",
			text: "Text me when you land.",
			retired: false,
		},
		{
			effective_from: JUN,
			name: "text me when you land",
			text: "Text me when you land and when you leave.",
			retired: false,
		},
	],
});

const ctx = (
	over: Partial<Parameters<typeof validateAgreementWrite>[1]> = {},
) =>
	({
		role: "dom",
		kinds: KINDS,
		agreements: [agreement()],
		cited: new Set<string>(),
		...over,
	}) as Parameters<typeof validateAgreementWrite>[1];

describe("agreementEffectiveAt — the occurred_at clock (ADR 0006)", () => {
	it("resolves to the version in force when the act happened", () => {
		// The ADR's example: the term tightened in June; an infraction logged in
		// July about a May act must read May's text, not June's.
		const may = JUN - 30 * 86_400_000;
		expect(agreementEffectiveAt(tightened, may)?.text).toBe(
			"Text me when you land.",
		);
	});

	it("resolves to the newer version for an act after it took force", () => {
		expect(agreementEffectiveAt(tightened, JUN + 1)?.text).toBe(
			"Text me when you land and when you leave.",
		);
	});

	it("takes force exactly at effective_from, not after it", () => {
		expect(agreementEffectiveAt(tightened, JUN)?.text).toBe(
			"Text me when you land and when you leave.",
		);
	});

	it("resolves to nothing before the first version", () => {
		// A citation cannot predate the term. Returning the earliest version would
		// bind someone to something not yet written.
		expect(agreementEffectiveAt(tightened, MAR - 1)).toBeNull();
	});

	it("ignores a version dated ahead of the moment asked about", () => {
		// Future-dating is the announced draft (there is no draft state): visible,
		// but not yet governing anything.
		const announced = agreement({
			versions: [
				...agreement().versions,
				{
					effective_from: JUN,
					name: "text me both ways",
					text: "…and when you leave.",
					retired: false,
				},
			],
		});
		expect(agreementEffectiveAt(announced, JUN - 1)?.name).toBe(
			"text me when you land",
		);
	});

	it("renders the name in force then, so a rename is not retroactive", () => {
		const renamed = agreement({
			versions: [
				...agreement().versions,
				{
					effective_from: JUN,
					name: "landing check-in",
					text: "Text me when you land.",
					retired: false,
				},
			],
		});
		expect(agreementEffectiveAt(renamed, MAR + 1)?.name).toBe(
			"text me when you land",
		);
		expect(agreementEffectiveAt(renamed, JUN + 1)?.name).toBe(
			"landing check-in",
		);
	});
});

describe("agreementsInForce — what a citing ref may offer", () => {
	const retired = agreement({
		id: "ag_old",
		versions: [
			...agreement().versions,
			{
				effective_from: JUN,
				name: "no phone at dinner",
				text: "",
				retired: true,
			},
		],
	});

	it("offers a live agreement", () => {
		expect(agreementsInForce([agreement()], JUN).map((a) => a.id)).toEqual([
			"ag_7f3",
		]);
	});

	it("stops offering a retired one", () => {
		// The opposite lifecycle from an echoing ref's candidates: a retired
		// Agreement leaves the picker, yet every past citation still resolves —
		// which the resolution tests above hold independently.
		expect(agreementsInForce([retired], JUN + 1)).toEqual([]);
		expect(agreementEffectiveAt(retired, MAR + 1)?.name).toBe(
			"text me when you land",
		);
	});

	it("offers one retired later than the moment asked about", () => {
		expect(agreementsInForce([retired], JUN - 1).map((a) => a.id)).toEqual([
			"ag_old",
		]);
	});

	it("does not offer one whose first version is still ahead", () => {
		expect(agreementsInForce([agreement()], MAR - 1)).toEqual([]);
	});
});

describe("authorsKind", () => {
	it("is true for a role the kind lists", () => {
		expect(authorsKind(KINDS, "limit", "sub")).toBe(true);
	});

	it("is false for a role it does not", () => {
		expect(authorsKind(KINDS, "limit", "dom")).toBe(false);
	});

	it("is false for an unresolved role", () => {
		// Before mutual confirmation nobody holds a role, so nobody authors.
		expect(authorsKind(KINDS, "protocol", null)).toBe(false);
	});

	it("is false for a kind that does not exist", () => {
		expect(authorsKind(KINDS, "nonsense", "dom")).toBe(false);
	});

	it("leaves limits unauthorable in a switch/switch couple", () => {
		// The ADR 0003 dormancy pattern, inherited: a `sub`-only kind matches
		// nobody when neither member holds that role. Recorded as a known
		// consequence rather than special-cased.
		expect(authorsKind(KINDS, "limit", "switch")).toBe(false);
	});
});

describe("validateAgreementWrite — authorship (ADR 0006)", () => {
	it("lets the dom write a protocol", () => {
		const r = validateAgreementWrite(
			{ op: "create", kind: "protocol", name: "n", text: "t" },
			ctx(),
		);
		expect(r.ok).toBe(true);
	});

	it("refuses the sub writing a protocol", () => {
		const r = validateAgreementWrite(
			{ op: "create", kind: "protocol", name: "n", text: "t" },
			ctx({ role: "sub" }),
		);
		expect(r).toMatchObject({ ok: false, forbidden: true });
	});

	it("lets the sub write a limit", () => {
		const r = validateAgreementWrite(
			{ op: "create", kind: "limit", name: "n", text: "t" },
			ctx({ role: "sub" }),
		);
		expect(r.ok).toBe(true);
	});

	it("refuses the dom editing the sub's limit", () => {
		// The headline safety property. A limit binds the dom, so the person it
		// protects is the only one who may change it.
		const limit = agreement({ id: "ag_2c", kind: "limit" });
		const r = validateAgreementWrite(
			{ op: "revise", id: "ag_2c", name: "n", text: "marks are fine now" },
			ctx({ agreements: [limit] }),
		);
		expect(r).toMatchObject({ ok: false, forbidden: true });
	});

	it("refuses the dom retiring the sub's limit", () => {
		const limit = agreement({ id: "ag_2c", kind: "limit" });
		const r = validateAgreementWrite(
			{ op: "retire", id: "ag_2c" },
			ctx({ agreements: [limit] }),
		);
		expect(r).toMatchObject({ ok: false, forbidden: true });
	});

	it("distinguishes an unknown agreement from a forbidden one", () => {
		// A 404 and a 403 are different answers, and the caller maps them to
		// different statuses — mirroring how amendment validation separates them.
		const r = validateAgreementWrite({ op: "retire", id: "nope" }, ctx());
		expect(r).toMatchObject({ ok: false });
		expect(r.ok === false && r.forbidden).toBeFalsy();
	});
});

describe("validateAgreementWrite — the escalation invariant (ADR 0006)", () => {
	it("refuses the dom adding themselves to the limit kind's authors", () => {
		// Closing the loop above: without this the dom simply edits the layer
		// above the limit and then edits the limit.
		const r = validateAgreementWrite(
			{ op: "edit_kind", id: "limit", author_permission: ["sub", "dom"] },
			ctx(),
		);
		expect(r).toMatchObject({ ok: false, forbidden: true });
	});

	it("lets the sub edit the limit kind they already author", () => {
		const r = validateAgreementWrite(
			{ op: "edit_kind", id: "limit", author_permission: ["sub", "switch"] },
			ctx({ role: "sub" }),
		);
		expect(r.ok).toBe(true);
	});

	it("refuses the dom re-kinding a protocol into a limit", () => {
		// The same escalation from the entry side: authoring in the sub's category
		// by moving something they already own into it.
		const r = validateAgreementWrite(
			{ op: "rekind", id: "ag_7f3", kind: "limit" },
			ctx(),
		);
		expect(r).toMatchObject({ ok: false, forbidden: true });
	});

	it("refuses the sub re-kinding their limit into a protocol", () => {
		// And the mirror: you must author both sides of the move, so neither role
		// can push an entry into the other's category either.
		const limit = agreement({ id: "ag_2c", kind: "limit" });
		const r = validateAgreementWrite(
			{ op: "rekind", id: "ag_2c", kind: "protocol" },
			ctx({ role: "sub", agreements: [limit] }),
		);
		expect(r).toMatchObject({ ok: false, forbidden: true });
	});

	it("allows a re-kind between two kinds the actor authors", () => {
		const r = validateAgreementWrite(
			{ op: "rekind", id: "ag_7f3", kind: "ritual" },
			ctx(),
		);
		expect(r.ok).toBe(true);
	});

	it("refuses a create into a kind that does not exist", () => {
		const r = validateAgreementWrite(
			{ op: "create", kind: "invented", name: "n", text: "t" },
			ctx(),
		);
		expect(r.ok).toBe(false);
	});
});

describe("validateAgreementWrite — delete legality (ADR 0002 parity)", () => {
	it("refuses deleting an agreement anything has ever cited", () => {
		// "Delete collapses to disable" — retiring keeps every version readable, so
		// terms someone was held to cannot leave the record.
		const r = validateAgreementWrite(
			{ op: "delete", id: "ag_7f3" },
			ctx({ cited: new Set(["ag_7f3"]) }),
		);
		expect(r.ok).toBe(false);
	});

	it("allows deleting one nothing has ever cited", () => {
		const r = validateAgreementWrite({ op: "delete", id: "ag_7f3" }, ctx());
		expect(r.ok).toBe(true);
	});

	it("still refuses a delete the actor may not author", () => {
		const limit = agreement({ id: "ag_2c", kind: "limit" });
		const r = validateAgreementWrite(
			{ op: "delete", id: "ag_2c" },
			ctx({ agreements: [limit] }),
		);
		expect(r).toMatchObject({ ok: false, forbidden: true });
	});
});
