// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/identity.ts", () => ({ hasIdentity: () => true }));
vi.mock("#/lib/api.ts", () => ({
	ackAgreementChanges: vi.fn(() => Promise.resolve({ ok: true })),
	createAgreement: vi.fn(() => Promise.resolve({})),
	deleteAgreement: vi.fn(() => Promise.resolve({})),
	retireAgreement: vi.fn(() => Promise.resolve({})),
	reviseAgreement: vi.fn(() => Promise.resolve({})),
	listAgreementKinds: vi.fn(() => Promise.resolve({ kinds: KINDS })),
	listRules: vi.fn(() => Promise.resolve({ rules: [] })),
	listEventTypes: vi.fn(() => Promise.resolve({ types: TYPES })),
	trackAgreement: vi.fn(() => Promise.resolve({})),
	listAgreements: vi.fn(() => Promise.resolve({ agreements: AGREEMENTS })),
	getRoles: vi.fn(() => Promise.resolve({ members: MEMBERS })),
}));

import {
	ackAgreementChanges,
	createAgreement,
	getRoles,
	listAgreementKinds,
	listAgreements,
	listEventTypes,
	listRules,
	retireAgreement,
	trackAgreement,
} from "#/lib/api.ts";
import type { AgreementKind, VersionedAgreement } from "#/shared/agreements.ts";
import type { EventType } from "#/shared/event-types.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { agreementKindDescription } from "#/templates/index.ts";
import { AgreementsView } from "./agreements-view.tsx";

/**
 * The Agreements screen (#121, ADR 0006). One screen for both roles, with
 * authoring gated per kind — so what these pin is mostly *absence*: the dom is
 * never offered a control over the sub's limits, because the guarantee that a
 * limit is the sub's has to be visible, not just enforced on the server.
 */

const NOW = 1_700_000_000_000;

const KINDS: AgreementKind[] = [
	{
		id: "protocol",
		label: "Protocol",
		author_permission: ["dom", "switch"],
		author_scope: "counterpart",
	},
	{
		id: "limit",
		label: "Limit",
		author_permission: ["dom", "sub", "switch"],
		author_scope: "subject",
	},
];

/**
 * The default viewpoint is the dom's: `m1` is self and holds `dom`, `m2` is the
 * sub. Both fixtures are therefore about `m2` — a protocol binds the sub
 * (`counterpart` scope) and the limit is the sub's own (`subject` scope), which is
 * what makes the dom's missing controls below meaningful rather than incidental.
 */
const AGREEMENTS: VersionedAgreement[] = [
	{
		id: "ag_1",
		kind: "protocol",
		subject: "m2",
		versions: [
			{
				effective_from: NOW - 10_000,
				name: "text me when you land",
				text: "Text me when you land.",
				retired: false,
			},
		],
	},
	{
		id: "ag_2",
		kind: "limit",
		subject: "m2",
		versions: [
			{
				effective_from: NOW - 10_000,
				name: "no marks above the collar",
				text: "",
				retired: false,
			},
		],
	},
];

/** The shipped ritual type, so the tracking derivation has something to find. */
const TYPES: EventType[] = [
	{
		id: "ritual_completed",
		label: "Ritual completed",
		valence: "positive",
		log_permission: ["dom", "sub", "switch"],
		subject_required: false,
		metadata: {
			ritual_id: {
				kind: "ref",
				ref_kind: "agreement",
				agreement_kind: "ritual",
				label: "Ritual",
				required: false,
				set_permission: ["dom", "sub", "switch"],
			},
		},
		awaiting: [],
		journaling: false,
	},
];

const MEMBERS: RoleMember[] = [
	{ member_id: "m1", role: "dom", is_self: true },
	{ member_id: "m2", role: "sub", is_self: false },
];

function asRole(role: "dom" | "sub") {
	vi.mocked(getRoles).mockResolvedValue({
		members: [
			{ member_id: "m1", role, is_self: true },
			{ member_id: "m2", role: role === "dom" ? "sub" : "dom", is_self: false },
		],
	} as Awaited<ReturnType<typeof getRoles>>);
}

async function renderView() {
	render(<AgreementsView />);
	await act(async () => {});
}

describe("AgreementsView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		vi.mocked(listAgreements).mockResolvedValue({ agreements: AGREEMENTS });
		asRole("dom");
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("shows both members every term, whoever authors it", async () => {
		// An Agreement is always shared: a term binds two people, so there is no
		// visibility gradient here to hide one side's entries behind.
		await renderView();
		expect(screen.getByText("text me when you land")).not.toBeNull();
		expect(screen.getByText("no marks above the collar")).not.toBeNull();
	});

	it("offers the dom a limit control too, since ADR 0010 widened the kind", () => {
		// The role list now says who may *hold* a term of a kind, and a dom holds
		// limits of their own — the corpus could not record one before, which is the
		// mirror of the hole #129 closed. What the dom still cannot do is touch the
		// sub's limit, which the next test pins.
		return renderView().then(() => {
			expect(
				screen.getByRole("button", { name: /add protocol/i }),
			).not.toBeNull();
			expect(screen.getByRole("button", { name: /add limit/i })).not.toBeNull();
		});
	});

	it("offers the sub a limit control and no protocol control", async () => {
		asRole("sub");
		await renderView();
		expect(screen.getByRole("button", { name: /add limit/i })).not.toBeNull();
		expect(screen.queryByRole("button", { name: /add protocol/i })).toBeNull();
	});

	it("gives the dom no way to edit or retire the sub's limit", async () => {
		// The headline safety property, seen from the screen. The server refuses it
		// too, but a button that always 403s is a worse answer than no button.
		await renderView();
		// The dom authors protocols, so exactly one row carries the controls.
		expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Retire" })).toHaveLength(1);
	});

	it("writes a new term into the kind it was added under", async () => {
		await renderView();
		fireEvent.click(screen.getByRole("button", { name: /add protocol/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /short name/i }), {
			target: { value: "no phone at dinner" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add protocol" }));
		await act(async () => {});

		expect(createAgreement).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "protocol", name: "no phone at dinner" }),
		);
	});

	it("takes two taps to retire, like everything else that can't be undone", async () => {
		await renderView();
		fireEvent.click(screen.getByRole("button", { name: "Retire" }));
		expect(retireAgreement).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Yes, retire" }));
		await act(async () => {});
		expect(retireAgreement).toHaveBeenCalledWith("ag_1");
	});

	it("keeps a retired term readable, apart from what still binds", async () => {
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [
				{
					...AGREEMENTS[0],
					versions: [
						...AGREEMENTS[0].versions,
						{
							effective_from: NOW - 5_000,
							name: "text me when you land",
							text: "",
							retired: true,
						},
					],
				},
			],
		});
		await renderView();

		expect(screen.getByText(/no longer in force/i)).not.toBeNull();
		expect(screen.getByText("text me when you land")).not.toBeNull();
		// Retired means retired: no author controls on it.
		expect(screen.queryByRole("button", { name: "Retire" })).toBeNull();
	});

	it("explains itself when nothing is written down yet", async () => {
		// Nothing ships in the corpus on purpose, so first run is empty and must
		// read as an invitation rather than a broken screen.
		vi.mocked(listAgreements).mockResolvedValue({ agreements: [] });
		await renderView();

		expect(screen.getByText(/nothing written down yet/i)).not.toBeNull();
	});

	it("marks a term whose change is dated ahead", async () => {
		// A future-dated version is the announced draft — visible, governing
		// nothing yet, and the row still reads what is actually in force.
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [
				{
					...AGREEMENTS[0],
					versions: [
						...AGREEMENTS[0].versions,
						{
							effective_from: NOW + 86_400_000,
							name: "text me both ways",
							text: "",
							retired: false,
						},
					],
				},
			],
		});
		await renderView();

		expect(screen.getByText("text me when you land")).not.toBeNull();
		expect(screen.getByText(/changes soon/i)).not.toBeNull();
	});
});

/**
 * Announcing a change rather than springing it (#121, stories 20/21). A future
 * `effective_from` is the only draft this corpus has, on purpose: a private
 * drafting space inside a consent record would be the one thing it shouldn't
 * have, so the way to not-yet-bind someone is to tell them when it starts.
 */
describe("AgreementsView — dating a change ahead", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		vi.mocked(listAgreements).mockResolvedValue({ agreements: AGREEMENTS });
		asRole("dom");
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("sends the chosen day as local midnight, not UTC", async () => {
		// A term takes force on the couple's day. Parsing the input string
		// directly would land it at UTC midnight — hours early or late depending
		// on where they are.
		await renderView();
		fireEvent.click(screen.getByRole("button", { name: /add protocol/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /short name/i }), {
			target: { value: "no phone at dinner" },
		});
		fireEvent.change(screen.getByLabelText(/starts on/i), {
			target: { value: "2026-09-01" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add protocol" }));
		await act(async () => {});

		expect(createAgreement).toHaveBeenCalledWith(
			expect.objectContaining({
				effective_from: new Date(2026, 8, 1).getTime(),
			}),
		);
	});

	it("leaves the date out entirely when blank, so it starts now", async () => {
		await renderView();
		fireEvent.click(screen.getByRole("button", { name: /add protocol/i }));
		fireEvent.change(screen.getByRole("textbox", { name: /short name/i }), {
			target: { value: "no phone at dinner" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add protocol" }));
		await act(async () => {});

		expect(createAgreement).toHaveBeenCalledWith(
			expect.objectContaining({ effective_from: undefined }),
		);
	});
});

describe("AgreementsView — a retired term", () => {
	const retiredAgreements = [
		{
			...AGREEMENTS[0],
			versions: [
				...AGREEMENTS[0].versions,
				{
					effective_from: NOW - 5_000,
					name: "text me when you land",
					text: "",
					retired: true,
				},
			],
		},
	];

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: retiredAgreements,
		});
		asRole("dom");
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("cannot be revised or retired again", async () => {
		await renderView();
		expect(screen.queryByRole("button", { name: "Retire" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
	});

	it("is still its author's to delete", async () => {
		// Retire-then-clean-up is the likeliest real path to a deletable entry, so
		// shutting the author out of a retired term would make story 27 unreachable
		// in practice. Whether it *is* deletable is the server's call — nothing the
		// client holds says whether the log ever cited it.
		await renderView();
		fireEvent.click(screen.getByText("text me when you land"));
		expect(
			screen.getByRole("button", { name: /delete for good/i }),
		).not.toBeNull();
	});
});

describe("AgreementsView — acknowledging a partner's change", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		vi.mocked(listAgreements).mockResolvedValue({ agreements: AGREEMENTS });
		asRole("sub");
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("marks corpus changes seen once the terms are on screen", async () => {
		// This screen is the content behind the count, so having read it is what
		// "seen" means — the same trade ADR 0002 makes for rules, where a notice
		// the bound party can reach is what stands in for a handshake.
		await renderView();
		expect(ackAgreementChanges).toHaveBeenCalled();
	});

	it("still shows the terms when the acknowledgement fails", async () => {
		// Showing a notice twice is the right failure; marking a change seen that
		// never reached the server is not.
		vi.mocked(ackAgreementChanges).mockRejectedValueOnce(new Error("offline"));
		await renderView();
		expect(screen.getByText("text me when you land")).not.toBeNull();
	});
});

/**
 * Tracking a ritual (#121, stories 34–36). The dom sees exactly what will be
 * created before it exists: three artifacts appearing unannounced in a couple's
 * counters and rules is the surprise this app avoids elsewhere by showing
 * mechanical fallout up front.
 */
describe("AgreementsView — tracking a ritual", () => {
	const RITUAL_KINDS: AgreementKind[] = [
		...KINDS,
		{
			id: "ritual",
			label: "Ritual",
			author_permission: ["dom", "switch"],
			author_scope: "counterpart",
		},
	];
	const KNEEL: VersionedAgreement = {
		id: "ag_7f3",
		kind: "ritual",
		// A ritual is the sub's to perform, and the dom's to write and to track.
		subject: "m2",
		versions: [
			{
				effective_from: NOW - 10_000,
				name: "morning kneel",
				text: "",
				retired: false,
			},
		],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		vi.mocked(listAgreementKinds).mockResolvedValue({ kinds: RITUAL_KINDS });
		vi.mocked(listAgreements).mockResolvedValue({ agreements: [KNEEL] });
		vi.mocked(listRules).mockResolvedValue({ rules: [] });
		asRole("dom");
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	/** The offer lives in the row's drawer, which opens on the term's name. */
	async function openRow() {
		await renderView();
		fireEvent.click(screen.getByText("morning kneel"));
	}

	it("offers tracking on a ritual its author can act on", async () => {
		await openRow();
		expect(screen.getByRole("button", { name: /track this/i })).not.toBeNull();
	});

	it("creates nothing until the plan has been shown and confirmed", async () => {
		await openRow();
		fireEvent.click(screen.getByRole("button", { name: /track this/i }));
		await act(async () => {});

		// The preview names all three, and nothing has been created yet.
		expect(screen.getByText(/this will add/i)).not.toBeNull();
		expect(screen.getByText(/morning kneel streak/)).not.toBeNull();
		expect(trackAgreement).not.toHaveBeenCalled();
	});

	it("tracks it once confirmed", async () => {
		await openRow();
		fireEvent.click(screen.getByRole("button", { name: /track this/i }));
		fireEvent.click(screen.getByRole("button", { name: /add them/i }));
		await act(async () => {});

		expect(trackAgreement).toHaveBeenCalledWith("ag_7f3");
	});

	it("stops offering once a rule already counts it", async () => {
		// Derived from the rules, not a stored flag — so a couple who built the
		// recipe by hand is recognised too.
		vi.mocked(listRules).mockResolvedValue({
			rules: [
				{
					id: "track_ag_7f3",
					enabled: true,
					condition: {
						type: "ritual_completed",
						metadata: { ritual_id: "ag_7f3" },
					},
					effects: [
						{ verb: "increment_counter", counter: "ag_7f3_today", by: 1 },
					],
				},
			],
		});
		await openRow();
		expect(screen.queryByRole("button", { name: /track this/i })).toBeNull();
	});

	it("offers nothing to a member who does not author rituals", async () => {
		asRole("sub");
		await openRow();
		expect(screen.queryByRole("button", { name: /track this/i })).toBeNull();
	});

	/**
	 * The screen half of #213.
	 *
	 * The fixtures above could not catch it: they hold only `ritual_completed`,
	 * whose ref names the kind it counts. The pack also ships `infraction`, whose
	 * `rule_ref` names no kind — deliberately, since a breach may cite any term —
	 * and `countingTypeFor` used to read that absence as "counts everything". So
	 * this adds the unqualified type the pack actually has, which is what makes
	 * the offer appear where it must not.
	 */
	const INFRACTION: EventType = {
		id: "infraction",
		label: "Infraction",
		valence: "negative",
		log_permission: ["dom", "sub", "switch"],
		subject_required: true,
		metadata: {
			rule_ref: {
				kind: "ref",
				ref_kind: "agreement",
				label: "Agreement",
				required: false,
				set_permission: ["dom", "sub", "switch"],
			},
		},
		awaiting: [],
		journaling: false,
	};

	it("never offers to track a limit, whatever else cites agreements", async () => {
		// Accepting it built a positive daily target of *one infraction against your
		// own limit*, with a streak of consecutive days of breaching it — rendered
		// on Today as met at 1/1. A missing button is the whole fix here, so it is
		// asserted from the screen rather than only from the derivation.
		vi.mocked(listAgreementKinds).mockResolvedValue({ kinds: RITUAL_KINDS });
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [
				{
					id: "ag_lim",
					kind: "limit",
					// The dom's own limit, so authorship is not what withholds the
					// control — otherwise this would pass for the wrong reason.
					subject: "m1",
					versions: [
						{
							effective_from: NOW - 10_000,
							name: "no breath play",
							text: "",
							retired: false,
						},
					],
				},
			],
		});
		vi.mocked(listEventTypes).mockResolvedValue({
			types: [...TYPES, INFRACTION],
		});
		await renderView();
		fireEvent.click(screen.getByText("no breath play"));

		expect(screen.queryByRole("button", { name: /track this/i })).toBeNull();
		expect(screen.queryByText(/keeps a streak/i)).toBeNull();
	});

	it("still offers tracking on a ritual with that type present", async () => {
		// The other half: narrowing the match must not cost the case it was for.
		vi.mocked(listEventTypes).mockResolvedValue({
			types: [...TYPES, INFRACTION],
		});
		await openRow();
		expect(screen.getByRole("button", { name: /track this/i })).not.toBeNull();
	});
});

/**
 * Whose term is whose, on screen (#160, ADR 0010).
 *
 * The guarantee is per-member now, and a missing button cannot express it: a dom
 * looking at a limit with no Edit control used to mean "your role doesn't hold this
 * kind" and can now also mean "this one is your partner's". Those are different
 * facts, and the second is the one the whole change exists to give.
 */
describe("AgreementsView — whose term it is", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		// Re-set explicitly: `clearAllMocks` clears calls, not implementations, so a
		// `mockResolvedValue` from a previous test would otherwise leak forward.
		vi.mocked(listAgreementKinds).mockResolvedValue({ kinds: KINDS });
		asRole("dom");
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("marks a scoped term as the partner's", async () => {
		vi.mocked(listAgreements).mockResolvedValue({ agreements: AGREEMENTS });
		await renderView();
		expect(screen.getAllByText("Your partner's").length).toBeGreaterThan(0);
	});

	it("marks the viewer's own term as theirs", async () => {
		// A dom's own limit, which the corpus could not hold at all before.
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [{ ...AGREEMENTS[1], id: "ag_mine", subject: "m1" }],
		});
		await renderView();
		expect(screen.getByText("Yours")).not.toBeNull();
		// And it is theirs to change, unlike the sub's.
		expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
	});

	it("leaves an unscoped kind unlabelled", async () => {
		// A safeword is the couple's shared record — there is no subject to name, so
		// a label would be inventing one.
		vi.mocked(listAgreementKinds).mockResolvedValue({
			kinds: [
				{
					id: "safeword",
					label: "Safeword",
					author_permission: ["dom", "sub", "switch"],
					author_scope: "unscoped",
				},
			],
		});
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [
				{ ...AGREEMENTS[0], id: "ag_sw", kind: "safeword", subject: undefined },
			],
		});
		await renderView();
		expect(screen.queryByText("Yours")).toBeNull();
		expect(screen.queryByText("Your partner's")).toBeNull();
	});

	it("leaves a section ungrouped while one person holds every term", async () => {
		// In a dom+sub couple every protocol is the sub's, so the heading never
		// appears and the screen is unchanged from before ADR 0010.
		vi.mocked(listAgreements).mockResolvedValue({ agreements: AGREEMENTS });
		await renderView();
		expect(screen.queryByRole("heading", { name: "Yours" })).toBeNull();
		expect(
			screen.queryByRole("heading", { name: "Your partner's" }),
		).toBeNull();
	});

	it("groups a section once it holds two people's terms", async () => {
		// Where the widened Limits kind put two subjects in one section — the case
		// that did not exist before, since a dom could not hold a limit.
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [
				AGREEMENTS[1],
				{ ...AGREEMENTS[1], id: "ag_mine", subject: "m1" },
			],
		});
		await renderView();
		expect(screen.getByRole("heading", { name: "Yours" })).not.toBeNull();
		expect(
			screen.getByRole("heading", { name: "Your partner's" }),
		).not.toBeNull();
		// The heading carries it, so the rows beneath do not repeat it.
		expect(screen.queryAllByText("Yours")).toHaveLength(1);
	});

	it("offers Retire but not Edit on a term whose subject was never recorded", async () => {
		// The retire-only residual: authored by nobody, so the couple's only way to
		// end it is to retire it and write a replacement that has a subject.
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [{ ...AGREEMENTS[1], id: "ag_orphan", subject: undefined }],
		});
		await renderView();
		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
		expect(screen.getByRole("button", { name: "Retire" })).not.toBeNull();
	});
});

/**
 * Gaps found reviewing #160 (ADR 0010:234 — an ownership label must be carried
 * "where the kind has a subject at all", and #159's notice must be reachable).
 */
describe("AgreementsView — review follow-ups", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		vi.mocked(listAgreementKinds).mockResolvedValue({ kinds: KINDS });
		asRole("dom");
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("labels a retired term too", async () => {
		// The case the label matters most for: a retired term's only control is
		// Delete, so a dom expanding their partner's retired limit would otherwise
		// get no control and nothing saying why.
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [
				{
					...AGREEMENTS[1],
					versions: [
						...AGREEMENTS[1].versions,
						{
							effective_from: NOW - 5_000,
							name: "no marks above the collar",
							text: "",
							retired: true,
						},
					],
				},
			],
		});
		await renderView();
		expect(screen.getByText(/no longer in force/i)).not.toBeNull();
		expect(screen.getByText("Your partner's")).not.toBeNull();
	});

	it("shows the new-default badge on an empty kind the viewer can't hold", async () => {
		// The section's "nothing here and not yours" early return used to run first,
		// so #159's notice was unreachable on exactly the kinds a couple is not in.
		vi.mocked(listAgreementKinds).mockResolvedValue({
			kinds: [
				{
					id: "protocol",
					label: "Protocol",
					author_permission: ["sub"],
					author_scope: "counterpart",
					upstream_changed: true,
				},
			],
		});
		vi.mocked(listAgreements).mockResolvedValue({ agreements: [] });
		await renderView();
		expect(screen.getByText("new default")).not.toBeNull();
	});

	it("uses one phrase for a term whose subject was never recorded", async () => {
		// Heading and chip must not drift apart, per CONTEXT.md's one-word rule.
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [
				{ ...AGREEMENTS[1], id: "ag_orphan", subject: undefined },
				{ ...AGREEMENTS[1], id: "ag_mine", subject: "m1" },
			],
		});
		await renderView();
		expect(
			screen.getByRole("heading", { name: "Not recorded" }),
		).not.toBeNull();

		// Ungrouped, the chip carries the same phrase rather than a second wording.
		cleanup();
		vi.mocked(listAgreements).mockResolvedValue({
			agreements: [{ ...AGREEMENTS[1], id: "ag_orphan", subject: undefined }],
		});
		await renderView();
		expect(screen.getByText("Not recorded")).not.toBeNull();
		expect(screen.queryByRole("heading", { name: "Not recorded" })).toBeNull();
	});
});

/**
 * The per-kind explainer (#210). Its initial state is the whole design: open
 * where the section is empty and the word is all the reader has, closed where the
 * couple's own terms explain the category better than any shipped sentence can.
 *
 * The description is asserted through `agreementKindDescription` rather than as a
 * quoted string, so these pin the *join* — a couple's stored kind, which carries
 * no description, meeting the pack's copy by id — and a reworded sentence does not
 * fail a test about mechanism.
 */
describe("AgreementsView — what a kind is", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		// Set every fixture this block reads, rather than inheriting: the initial
		// state under test *is* "does this section have terms", so a corpus left
		// over from a neighbouring test would silently decide the answer.
		vi.mocked(listAgreementKinds).mockResolvedValue({ kinds: KINDS });
		vi.mocked(listAgreements).mockResolvedValue({ agreements: AGREEMENTS });
		asRole("dom");
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("explains an empty kind without being asked", async () => {
		vi.mocked(listAgreements).mockResolvedValue({ agreements: [] });
		await renderView();

		const description = agreementKindDescription("protocol") as string;
		expect(screen.getByText(description)).not.toBeNull();
		// Derived from the author list, so the dom is told whom a protocol binds.
		expect(screen.getByText(/about your partner/i)).not.toBeNull();
	});

	it("steps back behind a toggle once the kind holds terms", async () => {
		await renderView();
		const description = agreementKindDescription("protocol") as string;
		expect(screen.queryByText(description)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "What's a protocol?" }));
		expect(screen.getByText(description)).not.toBeNull();
	});

	it("gives the sub the same explanation from their own side", async () => {
		// The `counterpart` guarantee is what the sub most needs said, since their
		// side of it is an *absent* control — nothing on the row says why.
		asRole("sub");
		await renderView();
		fireEvent.click(screen.getByRole("button", { name: "What's a protocol?" }));
		expect(screen.getByText(/your partner writes these/i)).not.toBeNull();
	});

	it("explains a kind the pack does not ship with what it can derive", async () => {
		// A description is pack-owned and a couple's own kind has none; the
		// authorship half is computed from their kind, so it is still there.
		vi.mocked(listAgreementKinds).mockResolvedValue({
			kinds: [
				{
					id: "house_rule",
					label: "House rule",
					author_permission: ["dom", "switch"],
					author_scope: "counterpart",
				},
			],
		});
		vi.mocked(listAgreements).mockResolvedValue({ agreements: [] });
		await renderView();

		expect(agreementKindDescription("house_rule")).toBeUndefined();
		expect(screen.getByText(/about your partner/i)).not.toBeNull();
	});
});
