// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({
	ackCrossings: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { ackCrossings } from "#/lib/api.ts";
import type { VersionedAgreement } from "#/shared/agreements.ts";
import type { Counter } from "#/shared/counters.ts";
import { GLOSSARY } from "#/shared/glossary.ts";
import { RungsPanel } from "./rungs-panel.tsx";

/**
 * The rung banner (#193, ADR 0015).
 *
 * Two properties carry the weight. It is derived from **where the counter sits**,
 * not from the crossing rows — so it clears by itself on a reset, a decrement or
 * a reversal, and there is nothing here to dismiss. And it takes no role, because
 * a ladder is a term the couple consented to and concealing its state from the
 * person it binds would make the consent record asymmetric.
 */

const TERM: VersionedAgreement = {
	id: "ag_ten",
	kind: "protocol",
	versions: [
		{
			effective_from: 0,
			name: "Ten demerits",
			text: "A week of corner time.",
			retired: false,
		},
	],
};

const counter = (
	value: number,
	rungs = [{ at: 10, agreement_ref: "ag_ten" }],
) =>
	({
		id: "demerits",
		name: "Demerits",
		valence: "negative",
		target_direction: "floor",
		reset: "on_acknowledgment",
		rungs,
		modify_permission: ["dom", "sub", "switch"],
		value,
		updated_at: null,
	}) as Counter;

describe("RungsPanel", () => {
	afterEach(() => {
		cleanup();
		vi.mocked(ackCrossings).mockClear();
	});

	it("shows the rung and the term's prose while at or above it", () => {
		render(<RungsPanel counters={[counter(12)]} agreements={[TERM]} />);
		expect(screen.getByText(/Demerits is at 12/)).not.toBeNull();
		expect(screen.getByText("Ten demerits")).not.toBeNull();
		expect(screen.getByText("A week of corner time.")).not.toBeNull();
	});

	it("renders nothing once the counter drops below", () => {
		// The banner is derived state: a reset, an acknowledgment, a decrement or a
		// reversal all clear it, and none of them is a case here.
		const { container } = render(
			<RungsPanel counters={[counter(9)]} agreements={[TERM]} />,
		);
		expect(container.textContent).toBe("");
	});

	it("has nothing to dismiss", () => {
		// A crossing is a recorded moment, not a debt (ADR 0015) — the "Got it" the
		// rule-change notice carries would assert an obligation was discharged.
		//
		// Stated as "the only control here is the explainer" rather than "no buttons
		// at all", which is what it used to say. That was a fine proxy while the
		// panel had no controls, but it made #212's explainer toggle read as a
		// regression — and a proxy that fails on the wrong change would eventually
		// be relaxed to `length <= 1`, which a real "Got it" would then pass.
		render(<RungsPanel counters={[counter(12)]} agreements={[TERM]} />);
		expect(
			screen.queryAllByRole("button").map((control) => control.textContent),
		).toEqual(["What is this?"]);
	});

	it("explains why the banner is here and how it goes away", () => {
		// The two halves (#212): what a rung is, which is shipped copy, and what
		// makes *this* one clear, which is the couple's own number.
		render(<RungsPanel counters={[counter(12)]} agreements={[TERM]} />);
		fireEvent.click(screen.getByRole("button", { name: "What is this?" }));
		// The word from the glossary, so it means the same here as where a rung is
		// written (#212 item 4); the number is this panel's own.
		expect(screen.getByText(GLOSSARY.rung.definition)).not.toBeNull();
		expect(screen.getByText(/drops back under 10/)).not.toBeNull();
	});

	it("stacks a row per rung the counter is above", () => {
		render(
			<RungsPanel
				counters={[
					counter(12, [
						{ at: 5, agreement_ref: "ag_ten" },
						{ at: 10, agreement_ref: "ag_ten" },
					]),
				]}
				agreements={[TERM]}
			/>,
		);
		// Both terms are in force at 12, so both are shown — highest first.
		expect(screen.getAllByText(/Demerits is at 12/)).toHaveLength(2);
	});

	it("names the ref when the couple no longer holds the term", () => {
		render(<RungsPanel counters={[counter(12)]} agreements={[]} />);
		expect(screen.getByText("ag_ten")).not.toBeNull();
	});

	it("acknowledges the count on arrival, banner or not", () => {
		// Not gated on a banner being here to see: a counter can fall back below its
		// rung before either member looks, and a badge that only cleared while a
		// banner showed would then never clear at all.
		render(<RungsPanel counters={[counter(0)]} agreements={[TERM]} />);
		return waitFor(() => expect(ackCrossings).toHaveBeenCalled());
	});

	it("waits for the counters before clearing the count", async () => {
		// Today paints this before the fetch resolves. Acking then would dismiss the
		// crossing a beat before the banner it would have shown — cleared by landing
		// on the screen rather than by being told.
		const { rerender } = render(
			<RungsPanel counters={[]} agreements={[TERM]} />,
		);
		await act(async () => {});
		expect(ackCrossings).not.toHaveBeenCalled();

		rerender(<RungsPanel counters={[counter(12)]} agreements={[TERM]} />);
		await waitFor(() => expect(ackCrossings).toHaveBeenCalled());
	});
});
