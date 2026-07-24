// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button.tsx";
import { Sheet, SheetContent, SheetTrigger } from "./sheet.tsx";

/**
 * The Log's write action opens onto this sheet (#91), so the dismissal contract
 * is load-bearing: the composer must open on the trigger and close on every
 * escape hatch (the close button, Escape, the backdrop) — a couple should never
 * feel trapped in a modal.
 */
function Harness() {
	return (
		<Sheet>
			<SheetTrigger asChild>
				<Button>Log an event</Button>
			</SheetTrigger>
			<SheetContent title="Log an event">
				<p>composer body</p>
			</SheetContent>
		</Sheet>
	);
}

describe("Sheet", () => {
	afterEach(cleanup);

	it("stays closed until the trigger is pressed", () => {
		render(<Harness />);
		expect(screen.queryByText("composer body")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Log an event" }));
		expect(screen.getByText("composer body")).not.toBeNull();
	});

	it("closes on the close button", () => {
		render(<Harness />);
		fireEvent.click(screen.getByRole("button", { name: "Log an event" }));

		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByText("composer body")).toBeNull();
	});

	it("closes on Escape", () => {
		render(<Harness />);
		fireEvent.click(screen.getByRole("button", { name: "Log an event" }));

		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		expect(screen.queryByText("composer body")).toBeNull();
	});
});
