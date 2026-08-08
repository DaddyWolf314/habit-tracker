// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Explainer } from "./explainer.tsx";

/**
 * The shared explainer toggle (#212 item 4's "shared disclosure primitive",
 * built for item 2 and adopted by #210's one-off).
 *
 * The aria wiring is what these tests are for. It is the part that throws
 * nothing when it is wrong and is invisible outside a screen reader, and the app
 * renders several of these on one screen — so a shared id, or a control naming a
 * node that isn't in the tree, is the failure worth pinning.
 */
describe("Explainer", () => {
	afterEach(cleanup);

	it("is a full-size tap target, in both states", () => {
		// CLAUDE.md: h-11 is the floor for this phone-first app, and `sm`/`xs` are
		// "for dense secondary rows … not by default". This sits alone under a
		// section heading, so it takes the default height — and the assertion is
		// here because the floor "rotted" once already by being nobody's to hold.
		// Asserted on `data-size` rather than the class string: the height belongs
		// to the Button variant, and re-deriving it here is what CLAUDE.md warns off.
		render(
			<Explainer label="What is this?">
				<p>Copy.</p>
			</Explainer>,
		);
		expect(screen.getByRole("button").getAttribute("data-size")).toBe(
			"default",
		);

		// Open too — "Hide" is the same control and the same target.
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByRole("button").getAttribute("data-size")).toBe(
			"default",
		);
	});

	it("starts closed, and asks the caller's question", () => {
		render(
			<Explainer label="What's a protocol?">
				<p>Something you've agreed.</p>
			</Explainer>,
		);
		const toggle = screen.getByRole("button", { name: "What's a protocol?" });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Something you've agreed.")).toBeNull();
	});

	it("opens onto the copy and says so", () => {
		render(
			<Explainer label="What is this?">
				<p>Something you've agreed.</p>
			</Explainer>,
		);
		fireEvent.click(screen.getByRole("button", { name: "What is this?" }));
		const toggle = screen.getByRole("button", { name: "Hide" });
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Something you've agreed.")).not.toBeNull();
	});

	it("names the panel it controls, and only while it is there", () => {
		// `aria-controls` must resolve. Collapsed, the panel is out of the tree, so
		// the id is expected to dangle — which is why the closed state is the one
		// that has to *not* be asserted against a node.
		render(
			<Explainer label="What is this?">
				<p>Copy.</p>
			</Explainer>,
		);
		fireEvent.click(screen.getByRole("button", { name: "What is this?" }));
		const controls = screen
			.getByRole("button", { name: "Hide" })
			.getAttribute("aria-controls");
		expect(controls).not.toBeNull();
		expect(document.getElementById(controls as string)?.textContent).toBe(
			"Copy.",
		);
	});

	it("gives every instance its own id", () => {
		// Today renders one of these per panel and the Agreements screen one per
		// kind (#148): two toggles sharing an id would point a screen reader at
		// somebody else's copy.
		render(
			<>
				<Explainer label="First">
					<p>One.</p>
				</Explainer>
				<Explainer label="Second">
					<p>Two.</p>
				</Explainer>
			</>,
		);
		const ids = screen
			.getAllByRole("button")
			.map((control) => control.getAttribute("aria-controls"));
		expect(new Set(ids).size).toBe(2);
	});

	it("opens on arrival when the caller says so, and stays where the reader puts it", () => {
		// `defaultOpen` is an initial state, not a controlled value: the Agreements
		// screen computes it from a section being empty, and a section filling up
		// under the reader must not yank the copy out mid-read.
		const { rerender } = render(
			<Explainer label="What is this?" defaultOpen>
				<p>Copy.</p>
			</Explainer>,
		);
		expect(screen.getByText("Copy.")).not.toBeNull();

		rerender(
			<Explainer label="What is this?" defaultOpen={false}>
				<p>Copy.</p>
			</Explainer>,
		);
		expect(screen.getByText("Copy.")).not.toBeNull();
	});
});
