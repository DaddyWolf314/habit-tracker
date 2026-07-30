import { describe, expect, it } from "vitest";
import {
	AGREEMENT_CHANGE_PREFIX,
	type AgreementKind,
	agreementChangeKind,
	agreementEffectiveAt,
	agreementRefKeys,
	agreementsInForce,
	authorsKind,
	describeCitation,
	latestAgreementVersion,
	reconcileAgreementKinds,
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
	{ id: "limit", label: "Limit", author_permission: ["sub", "switch"] },
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

	it("lets a switch author limits — a switch is partly a sub", () => {
		// ADR 0003's dormancy was the wrong thing to inherit here. A dom/sub
		// qualifier matching nobody is harmless for *rules* — scoring simply stops
		// — but a `sub`-only limit kind would mean a switch/switch couple could
		// not record a boundary at all, which is the opposite of what the kind is
		// for. A switch holds both sides of the dynamic, so they author both.
		expect(authorsKind(KINDS, "limit", "switch")).toBe(true);
		// The property that matters is unchanged: a plain dom still cannot.
		expect(authorsKind(KINDS, "limit", "dom")).toBe(false);
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
		// A 404 and a 403 are different answers, carried by flags rather than by
		// message text: a caller matching on prose would silently change status
		// codes the next time someone rewords an error.
		const r = validateAgreementWrite({ op: "retire", id: "nope" }, ctx());
		expect(r).toMatchObject({ ok: false, not_found: true });
		expect(r.ok === false && r.forbidden).toBeFalsy();
	});

	it("flags a forbidden write without flagging it missing", () => {
		const limit = agreement({ id: "ag_2c", kind: "limit" });
		const r = validateAgreementWrite(
			{ op: "retire", id: "ag_2c" },
			ctx({ agreements: [limit] }),
		);
		expect(r).toMatchObject({ ok: false, forbidden: true });
		expect(r.ok === false && r.not_found).toBeFalsy();
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

describe("agreementRefKeys — which metadata cites the corpus", () => {
	const field = (kind: string, refKind?: string) => ({
		kind,
		...(refKind ? { ref_kind: refKind } : {}),
	});

	it("finds a ref field declaring the agreement kind", () => {
		expect(
			agreementRefKeys({
				metadata: {
					rule_ref: field("ref", "agreement"),
					severity: field("enum"),
				},
			}),
		).toEqual(["rule_ref"]);
	});

	it("ignores refs pointing at anything else", () => {
		// A task ref names an id an event minted; only a citing ref names a row in
		// the corpus, and the declared `ref_kind` is what says which.
		expect(
			agreementRefKeys({ metadata: { task_id: field("ref", "task") } }),
		).toEqual([]);
	});

	it("finds nothing before the pack declares any", () => {
		// Correct rather than a stub: nothing can cite a corpus nothing points at,
		// so the hard-delete gate is vacuously satisfied until the pack change.
		expect(agreementRefKeys({ metadata: { severity: field("enum") } })).toEqual(
			[],
		);
	});
});

describe("agreementChangeKind — the consent-history vocabulary", () => {
	it("namespaces every op so corpus changes select out of the history", () => {
		expect(agreementChangeKind("create")).toBe("agreement_create");
		expect(agreementChangeKind("edit_kind")).toBe("agreement_edit_kind");
		expect(
			agreementChangeKind("retire").startsWith(AGREEMENT_CHANGE_PREFIX),
		).toBe(true);
	});
});

describe("latestAgreementVersion — what a retirement must follow", () => {
	it("is the last version written, not the one in force", () => {
		// The distinction that matters for retiring: an announced draft dated ahead
		// is the latest version while governing nothing yet.
		const announced = agreement({
			versions: [
				...agreement().versions,
				{
					effective_from: JUN,
					name: "landing check-in",
					text: "…and when you leave.",
					retired: false,
				},
			],
		});
		expect(latestAgreementVersion(announced).name).toBe("landing check-in");
		expect(agreementEffectiveAt(announced, MAR + 1)?.name).toBe(
			"text me when you land",
		);
	});

	it("is defined for a draft-only Agreement, where nothing is in force", () => {
		// The case that made retiring write an empty name and sort *before* the
		// pending draft, so the draft would arrive and un-retire the term.
		const draftOnly = agreement({
			versions: [
				{
					effective_from: JUN,
					name: "not yet",
					text: "starts in June",
					retired: false,
				},
			],
		});
		expect(agreementEffectiveAt(draftOnly, MAR)).toBeNull();
		expect(latestAgreementVersion(draftOnly).name).toBe("not yet");
	});

	it("is order-independent", () => {
		const unsorted = agreement({
			versions: [
				{ effective_from: JUN, name: "later", text: "", retired: false },
				{ effective_from: MAR, name: "earlier", text: "", retired: false },
			],
		});
		expect(latestAgreementVersion(unsorted).name).toBe("later");
	});
});

describe("validateAgreementWrite — forward-only dating (ADR 0006)", () => {
	it("refuses a version dated into the past", () => {
		// The guarantee the corpus rests on, reached from the other direction: a
		// backdated version would make an infraction about last week resolve
		// against text written today.
		const r = validateAgreementWrite(
			{
				op: "revise",
				id: "ag_7f3",
				name: "n",
				text: "t",
				effective_from: MAR - 1,
			},
			ctx({ now: MAR }),
		);
		expect(r).toMatchObject({ ok: false });
		expect(r.ok === false && r.forbidden).toBeFalsy();
	});

	it("allows a version dated ahead — that is the announced draft", () => {
		const r = validateAgreementWrite(
			{ op: "revise", id: "ag_7f3", name: "n", text: "t", effective_from: JUN },
			ctx({ now: MAR + 1 }),
		);
		expect(r.ok).toBe(true);
	});

	it("refuses one that would land at or before an existing version", () => {
		// Including a pending draft: a version resolved past is no version at all.
		const announced = agreement({
			versions: [
				...agreement().versions,
				{ effective_from: JUN, name: "later", text: "", retired: false },
			],
		});
		const r = validateAgreementWrite(
			{ op: "revise", id: "ag_7f3", name: "n", text: "t", effective_from: JUN },
			ctx({ now: MAR + 1, agreements: [announced] }),
		);
		expect(r.ok).toBe(false);
	});

	it("takes an unset date as now", () => {
		const r = validateAgreementWrite(
			{ op: "revise", id: "ag_7f3", name: "n", text: "t" },
			ctx({ now: JUN }),
		);
		expect(r.ok).toBe(true);
	});
});

describe("describeCitation — how a citation reads (story 23)", () => {
	const renamed = agreement({
		versions: [
			{ effective_from: MAR, name: "morning kneel", text: "", retired: false },
			{ effective_from: JUN, name: "dawn ritual", text: "", retired: false },
		],
	});

	it("reads the name in force when the act happened", () => {
		// Rendering today's name would quietly rewrite what the person agreed to —
		// the retroactivity the occurred_at clock exists to prevent, moved from
		// resolution into display.
		expect(describeCitation([renamed], "ag_7f3", MAR + 1, JUN + 1)).toBe(
			"morning kneel (now: dawn ritual)",
		);
	});

	it("says nothing extra when the name never changed", () => {
		expect(describeCitation([agreement()], "ag_7f3", MAR + 1, JUN)).toBe(
			"text me when you land",
		);
	});

	it("shows one name for an act after the rename", () => {
		expect(describeCitation([renamed], "ag_7f3", JUN + 1, JUN + 2)).toBe(
			"dawn ritual",
		);
	});

	it("still resolves a citation of a retired term", () => {
		// Retiring drops it from the picker; it must not drop out of the log.
		const retired = agreement({
			versions: [
				...agreement().versions,
				{
					effective_from: JUN,
					name: "text me when you land",
					text: "",
					retired: true,
				},
			],
		});
		expect(describeCitation([retired], "ag_7f3", MAR + 1, JUN + 1)).toBe(
			"text me when you land",
		);
	});

	it("returns nothing for an id the couple doesn't hold", () => {
		// A free-text citation logged before the pack change, or a hard-deleted
		// term. The caller shows the raw value — an opaque id beats a blank.
		expect(
			describeCitation([agreement()], "morning_kneel", MAR, JUN),
		).toBeNull();
	});
});

/**
 * Adopt-on-edit reconciliation for the kinds pack (#159, ADR 0010).
 *
 * The property under test is the one the corpus was shipped without: a couple's
 * own author list survives a pack bump. Before this, `seedAgreementKinds` upserted
 * `author_permission` unconditionally, so tightening a kind by hand — the only
 * workaround for #129's hole — was undone by the next ship.
 */
describe("reconcileAgreementKinds", () => {
	const packLimit: AgreementKind = {
		id: "limit",
		label: "Limit",
		author_permission: ["sub", "switch"],
	};

	it("installs a kind the couple doesn't have yet", () => {
		const result = reconcileAgreementKinds([packLimit], []);
		expect(result.added).toEqual([packLimit]);
		expect(result.upserted).toEqual([]);
		expect(result.skipped).toEqual([]);
	});

	it("moves an un-adopted kind with the pack", () => {
		// Still tracking the pack, so a changed default applies rather than waiting.
		const result = reconcileAgreementKinds(
			[{ ...packLimit, author_permission: ["dom", "sub", "switch"] }],
			[{ ...packLimit, adopted: false }],
		);
		expect(result.upserted).toEqual([
			{ ...packLimit, author_permission: ["dom", "sub", "switch"] },
		]);
		expect(result.skipped).toEqual([]);
	});

	it("never overwrites an adopted kind, and flags the new default", () => {
		// The regression this exists to prevent: the couple tightened `limit` to
		// `[sub]`, and a ship widening it must not silently take that back.
		const result = reconcileAgreementKinds(
			[{ ...packLimit, author_permission: ["dom", "sub", "switch"] }],
			[{ ...packLimit, author_permission: ["sub"], adopted: true }],
		);
		expect(result.upserted).toEqual([]);
		expect(result.skipped).toEqual([
			{ id: "limit", label: "Limit", changedUpstream: true },
		]);
	});

	it("does not flag an adopted kind the pack didn't change", () => {
		const result = reconcileAgreementKinds(
			[packLimit],
			[{ ...packLimit, adopted: true }],
		);
		expect(result.skipped).toEqual([
			{ id: "limit", label: "Limit", changedUpstream: false },
		]);
	});

	it("reads a reordered role list as unchanged", () => {
		// A notice the couple learns to dismiss is worse than no notice, so the
		// comparison is a set — the same call `sameDefinition` makes about a rename.
		const result = reconcileAgreementKinds(
			[{ ...packLimit, author_permission: ["switch", "sub"] }],
			[{ ...packLimit, adopted: true }],
		);
		expect(result.skipped).toEqual([
			{ id: "limit", label: "Limit", changedUpstream: false },
		]);
	});

	it("carries a corrected label to an adopted kind", () => {
		// `label` has no editing surface, so it is pack-owned and applied rather than
		// announced. Freezing the whole row would strand a typo fix forever on
		// exactly the couples who edited the permission beside it.
		const result = reconcileAgreementKinds(
			[{ ...packLimit, label: "Limits" }],
			[{ ...packLimit, adopted: true }],
		);
		expect(result.skipped).toEqual([
			{ id: "limit", label: "Limits", changedUpstream: false },
		]);
	});

	it("upserts an un-adopted kind for a label change alone", () => {
		const result = reconcileAgreementKinds(
			[{ ...packLimit, label: "Limits" }],
			[packLimit],
		);
		expect(result.upserted).toEqual([{ ...packLimit, label: "Limits" }]);
	});

	it("ignores a kind the pack doesn't ship", () => {
		// A couple's own kind is never the pack's business, the same way
		// `reconcilePack` ignores custom rules.
		const result = reconcileAgreementKinds(
			[packLimit],
			[
				{ ...packLimit, adopted: false },
				{ id: "aftercare", label: "Aftercare", author_permission: ["dom"] },
			],
		);
		expect(result.added).toEqual([]);
		expect(result.upserted).toEqual([]);
		expect(result.skipped).toEqual([]);
	});
});
