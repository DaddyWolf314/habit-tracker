// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	ApiError: class ApiError extends Error {},
	confirmRoles: vi.fn(() => Promise.resolve(roles())),
	createIdentity: vi.fn(() => Promise.resolve({})),
	createInvite: vi.fn(() =>
		Promise.resolve({ code: "abc-123", expires_at: 1_700_000_900_000 }),
	),
	getRoles: vi.fn(() => Promise.resolve(roles())),
	getSession: vi.fn(() => Promise.resolve({})),
	linkDevice: vi.fn(() => Promise.resolve({})),
	proposeRoles: vi.fn(() => Promise.resolve(roles())),
	redeemInvite: vi.fn(() => Promise.resolve({})),
}));

vi.mock("#/lib/identity.ts", () => ({
	clearCredentials: vi.fn(),
	generateSecret: vi.fn(),
	hasIdentity: () => true,
	secretFromMnemonic: vi.fn(),
	storeDeviceToken: vi.fn(),
	storeSecret: vi.fn(),
}));

import { confirmRoles, createInvite } from "#/lib/api.ts";
import { LIVE_REFRESH_MS } from "#/lib/use-live-refresh.ts";
import type { RoleConfirmationState } from "#/shared/identity.ts";
import { Ceremony, InvitePanel, RolesPanel } from "./onboarding.tsx";

/**
 * Two taps on the pre-dynamic home that can't be walked back (#93).
 *
 * Confirming roles is the heavier one: the second partner's confirmation
 * activates the couple, after which `proposeRoles` refuses forever ("roles are
 * already confirmed") and there is no reassignment endpoint — the only way out
 * of a wrong assignment is dissolving the space and losing all of its history.
 * Regenerating an invite silently kills the code already sent to the partner.
 */

/** A partner's proposal waiting on this member — the state the Confirm tap lives in. */
function roles(
	over: Partial<RoleConfirmationState> = {},
): RoleConfirmationState {
	return {
		members: [
			{ member_id: "m1", role: null, is_self: true },
			{ member_id: "m2", role: null, is_self: false },
		],
		assignment: { m1: "sub", m2: "dom" },
		proposed_by: "m2",
		confirmed_by: [],
		active: false,
		...over,
	};
}

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

async function renderRoles() {
	render(<RolesPanel onActivated={() => {}} />);
	// The panel reads the proposal in an effect; let it settle before asserting.
	await act(async () => {});
}

describe("confirming roles", () => {
	beforeEach(() => {
		vi.mocked(confirmRoles).mockClear();
	});
	afterEach(cleanup);

	it("does not confirm on the first tap", async () => {
		await renderRoles();
		click("Confirm these roles");
		expect(vi.mocked(confirmRoles)).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Yes, these are our roles" }),
		).not.toBeNull();
	});

	it("says the choice is permanent before taking it", async () => {
		await renderRoles();
		click("Confirm these roles");
		expect(screen.getByText(/can't be reassigned/i)).not.toBeNull();
	});

	it("confirms on the second tap", async () => {
		await renderRoles();
		click("Confirm these roles");
		click("Yes, these are our roles");
		await act(async () => {});
		expect(vi.mocked(confirmRoles)).toHaveBeenCalled();
	});

	it("backing out drops the confirm without activating", async () => {
		await renderRoles();
		click("Confirm these roles");
		click("Not yet");
		expect(vi.mocked(confirmRoles)).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Yes, these are our roles" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Confirm these roles" }),
		).not.toBeNull();
	});
});

describe("regenerating an invite code", () => {
	beforeEach(() => {
		vi.mocked(createInvite).mockClear();
	});
	afterEach(cleanup);

	/** Gets the panel past the first, additive "Create invite" tap. */
	async function renderWithLiveInvite() {
		render(<InvitePanel onRefresh={() => {}} />);
		click("Create invite");
		await act(async () => {});
		vi.mocked(createInvite).mockClear();
	}

	it("creates the first code on a single tap — nothing exists to lose yet", async () => {
		render(<InvitePanel onRefresh={() => {}} />);
		click("Create invite");
		await act(async () => {});
		expect(vi.mocked(createInvite)).toHaveBeenCalled();
	});

	it("does not replace a live code on the first tap", async () => {
		await renderWithLiveInvite();
		click("New code");
		expect(vi.mocked(createInvite)).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Yes, replace it" }),
		).not.toBeNull();
	});

	it("replaces on the second tap", async () => {
		await renderWithLiveInvite();
		click("New code");
		click("Yes, replace it");
		await act(async () => {});
		expect(vi.mocked(createInvite)).toHaveBeenCalled();
	});

	it("backing out keeps the code already sent", async () => {
		await renderWithLiveInvite();
		click("New code");
		click("Keep the old code");
		expect(vi.mocked(createInvite)).not.toHaveBeenCalled();
		expect(screen.getByText("abc-123")).not.toBeNull();
	});
});

/**
 * Handing the code off (#96). The code has to reach another person's device, and
 * the join lands over there — so the panel copies in one tap and notices the
 * partner arriving on its own, rather than making them tap "I've paired".
 */
describe("handing off the invite", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	async function renderWithLiveInvite(onRefresh: () => void = () => {}) {
		render(<InvitePanel onRefresh={onRefresh} />);
		click("Create invite");
		await act(async () => {});
	}

	it("copies the code to the clipboard", async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		await renderWithLiveInvite();
		click("Copy");
		await act(async () => {});
		expect(writeText).toHaveBeenCalledWith("abc-123");
		expect(screen.getByRole("button", { name: "Copied" })).not.toBeNull();
	});

	it("survives a clipboard that refuses", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: () => Promise.reject(new Error("denied")),
			},
			configurable: true,
		});
		await renderWithLiveInvite();
		click("Copy");
		await act(async () => {});
		// Still the code on screen to copy by hand, and no error painted over it.
		expect(screen.getByText("abc-123")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Copy" })).not.toBeNull();
	});

	it("polls for the partner's join while it is open", async () => {
		vi.useFakeTimers();
		const onRefresh = vi.fn();
		render(<InvitePanel onRefresh={onRefresh} />);
		expect(onRefresh).not.toHaveBeenCalled();
		await act(async () => {
			vi.advanceTimersByTime(LIVE_REFRESH_MS);
		});
		expect(onRefresh).toHaveBeenCalled();
	});

	it("stops polling once it is off screen", async () => {
		vi.useFakeTimers();
		const onRefresh = vi.fn();
		const view = render(<InvitePanel onRefresh={onRefresh} />);
		view.unmount();
		await act(async () => {
			vi.advanceTimersByTime(LIVE_REFRESH_MS * 3);
		});
		expect(onRefresh).not.toHaveBeenCalled();
	});
});

/**
 * The recovery-phrase ceremony's confirmation step (#96). The phrase is
 * unrecoverable by design, so "I've written it down" can't be the only gate —
 * the words have to come back before the space is built on them.
 */
describe("confirming the recovery phrase", () => {
	afterEach(cleanup);

	// 24 distinct words, so an answer is unambiguous about which position it came from.
	const WORDS = [
		"alpha",
		"bravo",
		"charlie",
		"delta",
		"echo",
		"foxtrot",
		"golf",
		"hotel",
		"india",
		"juliet",
		"kilo",
		"lima",
		"mike",
		"november",
		"oscar",
		"papa",
		"quebec",
		"romeo",
		"sierra",
		"tango",
		"uniform",
		"victor",
		"whiskey",
		"xray",
	];
	const PHRASE = WORDS.join(" ");

	function renderCeremony(onDone = vi.fn()) {
		render(
			<Ceremony mnemonic={PHRASE} busy={false} error={null} onDone={onDone} />,
		);
		return onDone;
	}

	/** The word positions the check is currently asking about, in prompt order. */
	function asked(): number[] {
		return screen
			.getAllByText(/^Word \d+$/)
			.map((el) => Number((el.textContent ?? "").replace("Word ", "")));
	}

	function fillIn(value: (position: number) => string) {
		const inputs = screen.getAllByRole("textbox");
		asked().forEach((position, i) => {
			fireEvent.change(inputs[i], { target: { value: value(position) } });
		});
	}

	/** Ticks the acknowledgement and moves on to the check. */
	function reachCheck() {
		fireEvent.click(screen.getByRole("checkbox"));
		click("Continue");
	}

	it("does not finish on the checkbox alone", () => {
		const onDone = renderCeremony();
		reachCheck();
		expect(onDone).not.toHaveBeenCalled();
		expect(asked()).toHaveLength(3);
	});

	it("hides the phrase while it asks for it back", () => {
		renderCeremony();
		reachCheck();
		expect(screen.queryByText("alpha")).toBeNull();
	});

	it("finishes once the right words come back", () => {
		const onDone = renderCeremony();
		reachCheck();
		fillIn((position) => WORDS[position - 1]);
		click("Continue");
		expect(onDone).toHaveBeenCalled();
	});

	it("forgives case and stray spaces", () => {
		const onDone = renderCeremony();
		reachCheck();
		fillIn((position) => ` ${WORDS[position - 1].toUpperCase()} `);
		click("Continue");
		expect(onDone).toHaveBeenCalled();
	});

	it("refuses words that aren't the phrase's, and says so", () => {
		const onDone = renderCeremony();
		reachCheck();
		fillIn(() => "zulu");
		click("Continue");
		expect(onDone).not.toHaveBeenCalled();
		expect(screen.getByText(/doesn't match the phrase/i)).not.toBeNull();
	});

	it("refuses when one of the words is wrong", () => {
		const onDone = renderCeremony();
		reachCheck();
		const positions = asked();
		fillIn((position) =>
			position === positions[0] ? "zulu" : WORDS[position - 1],
		);
		click("Continue");
		expect(onDone).not.toHaveBeenCalled();
	});

	it("won't submit a half-filled answer", () => {
		renderCeremony();
		reachCheck();
		const positions = asked();
		const inputs = screen.getAllByRole("textbox");
		fireEvent.change(inputs[0], {
			target: { value: WORDS[positions[0] - 1] },
		});
		expect(
			screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("re-reading the phrase asks about the same words", () => {
		renderCeremony();
		reachCheck();
		const first = asked();
		click("Show me the phrase again");
		expect(screen.getByText("alpha")).not.toBeNull();
		click("Continue");
		expect(asked()).toEqual(first);
	});
});
