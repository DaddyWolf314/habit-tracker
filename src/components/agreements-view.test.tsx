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
	createAgreement: vi.fn(() => Promise.resolve({})),
	deleteAgreement: vi.fn(() => Promise.resolve({})),
	retireAgreement: vi.fn(() => Promise.resolve({})),
	reviseAgreement: vi.fn(() => Promise.resolve({})),
	listAgreementKinds: vi.fn(() => Promise.resolve({ kinds: KINDS })),
	listAgreements: vi.fn(() => Promise.resolve({ agreements: AGREEMENTS })),
	getRoles: vi.fn(() => Promise.resolve({ members: MEMBERS })),
}));

import {
	createAgreement,
	getRoles,
	listAgreements,
	retireAgreement,
} from "#/lib/api.ts";
import type { AgreementKind, VersionedAgreement } from "#/shared/agreements.ts";
import type { RoleMember } from "#/shared/identity.ts";
import { AgreementsView } from "./agreements-view.tsx";

/**
 * The Agreements screen (#121, ADR 0006). One screen for both roles, with
 * authoring gated per kind — so what these pin is mostly *absence*: the dom is
 * never offered a control over the sub's limits, because the guarantee that a
 * limit is the sub's has to be visible, not just enforced on the server.
 */

const NOW = 1_700_000_000_000;

const KINDS: AgreementKind[] = [
	{ id: "protocol", label: "Protocol", author_permission: ["dom", "switch"] },
	{ id: "limit", label: "Limit", author_permission: ["sub", "switch"] },
];

const AGREEMENTS: VersionedAgreement[] = [
	{
		id: "ag_1",
		kind: "protocol",
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

	it("offers the dom a protocol control and no limit control", async () => {
		await renderView();
		expect(
			screen.getByRole("button", { name: /add protocol/i }),
		).not.toBeNull();
		expect(screen.queryByRole("button", { name: /add limit/i })).toBeNull();
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
