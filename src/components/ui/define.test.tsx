// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GLOSSARY } from "#/shared/glossary.ts";
import { Define } from "./define.tsx";

/**
 * Inline definitions (#212 item 4) — the bet chosen over a Help screen, on the
 * #210 argument that an explanation is worth most where the question arises.
 *
 * The properties here are about the *join*: that the label asks about the word
 * the body defines, and that the text on screen is the glossary's rather than a
 * second copy of it. Nothing asserts the wording, which is free to change.
 */
describe("Define", () => {
	afterEach(cleanup);

	it("asks about the word it defines", () => {
		render(<Define terms={["rung"]} />);
		expect(
			screen.getByRole("button", { name: "What's a rung?" }),
		).not.toBeNull();
	});

	it("shows the glossary's own definition, not a copy of it", () => {
		render(<Define terms={["counter"]} />);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText(GLOSSARY.counter.definition)).not.toBeNull();
	});

	it("puts several words behind one toggle", () => {
		// Two toggles side by side would make the reader choose which word they are
		// confused about before finding out.
		render(<Define terms={["counter", "streak", "rung"]} />);
		expect(screen.getAllByRole("button")).toHaveLength(1);

		fireEvent.click(
			screen.getByRole("button", { name: "What do these words mean?" }),
		);
		for (const id of ["counter", "streak", "rung"] as const) {
			expect(screen.getByText(GLOSSARY[id].definition)).not.toBeNull();
		}
	});

	it("leads each entry with the term, in the order asked for", () => {
		// A reading order, not a set — "streak" only means anything after "counter",
		// so the caller's order ships. Asserted against alphabetical so a stray sort
		// would fail rather than coincide.
		render(<Define terms={["price", "currency"]} />);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getAllByRole("term").map((node) => node.textContent)).toEqual(
			["price", "currency"],
		);
	});

	it("renders the derived half a surface passes in, after the words", () => {
		// The slot that lets Today's clocks and ladder panels keep their computed
		// sentence and still take their word from the glossary, instead of rendering
		// the definition themselves.
		render(
			<Define terms={["clock"]}>
				<p>One of these has never been reset.</p>
			</Define>,
		);
		fireEvent.click(screen.getByRole("button"));
		const panel = screen.getByText(/One of these has never been reset/);
		expect(panel).not.toBeNull();
		// After the definitions, since it is only meaningful once the word is.
		expect(
			screen
				.getByText(GLOSSARY.clock.definition)
				.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("starts closed, so it costs nothing on a screen nobody is confused by", () => {
		render(<Define terms={["waiver"]} />);
		expect(screen.queryByText(GLOSSARY.waiver.definition)).toBeNull();
	});

	it("renders nothing for no terms", () => {
		const { container } = render(<Define terms={[]} />);
		expect(container.textContent).toBe("");
	});
});
