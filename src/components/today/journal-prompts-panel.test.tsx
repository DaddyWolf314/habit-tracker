// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api.ts", () => ({ logEvent: vi.fn(() => Promise.resolve({})) }));

import { logEvent } from "#/lib/api.ts";
import type { OpenPromptView } from "#/shared/journaling.ts";
import { JournalPromptsPanel } from "./journal-prompts-panel.tsx";

/**
 * Visibility on the Today answer surface (#94, #106). This panel is a second
 * write path to the same `journal_entry` the composer logs, so it is bound by the
 * same rule (ADR 0001, CONTEXT §Visibility — "the author *always* chooses
 * explicitly; there is no silent default"). A preselected control here would
 * leak an unmade choice to `shared` on the surface a sub is most likely to answer
 * from — the prompt is in front of them, and the deadline is ticking.
 */

function prompt(partial: Partial<OpenPromptView> = {}): OpenPromptView {
	return {
		prompt_id: "p1",
		question: "How did today feel?",
		floor: null,
		deadline_at: null,
		paused: false,
		expired: false,
		...partial,
	};
}

function renderPanel(prompts: OpenPromptView[], onChange = () => {}) {
	return render(
		<JournalPromptsPanel openPrompts={prompts} onChange={onChange} />,
	);
}

/** Opens the inline answer form for the first prompt. */
function startAnswering() {
	fireEvent.click(screen.getByRole("button", { name: /answer/i }));
}

/** The visibility select inside the open answer form, by its label (#148). */
const picker = () => screen.getByRole("combobox", { name: /visibility/i });

/** Fills the prose, which is required before the form will submit at all. */
function writeAnswer(text = "it was fine") {
	fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}

describe("JournalPromptsPanel visibility", () => {
	beforeEach(() => vi.mocked(logEvent).mockClear());
	afterEach(cleanup);

	it("preselects nothing", () => {
		renderPanel([prompt()]);
		startAnswering();

		expect(picker()).toHaveProperty("value", "");
	});

	it("refuses to answer until visibility is chosen", async () => {
		renderPanel([prompt()]);
		startAnswering();
		writeAnswer();

		fireEvent.click(screen.getByRole("button", { name: "Answer" }));
		await act(async () => {});

		expect(logEvent).not.toHaveBeenCalled();
		expect(screen.getByText(/before you answer/i)).not.toBeNull();
	});

	it("logs the chosen visibility once it is set", async () => {
		const onChange = vi.fn();
		renderPanel([prompt()], onChange);
		startAnswering();
		writeAnswer("kneeling was hard today");
		fireEvent.change(picker(), { target: { value: "sealed" } });

		fireEvent.click(screen.getByRole("button", { name: "Answer" }));
		await act(async () => {});

		expect(onChange).toHaveBeenCalled();
		expect(logEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "journal_entry",
				note: "kneeling was hard today",
				visibility: "sealed",
			}),
		);
	});

	it("still allows a below-floor answer", async () => {
		// A floor says which answers *discharge* the assignment, never which the sub
		// may log: answering below it stays their right, and the server decides
		// whether it counts. The form must not turn a hint into a gate.
		renderPanel([prompt({ floor: "shared" })]);
		startAnswering();
		writeAnswer();
		fireEvent.change(picker(), { target: { value: "secret" } });

		fireEvent.click(screen.getByRole("button", { name: "Answer" }));
		await act(async () => {});

		expect(logEvent).toHaveBeenCalledWith(
			expect.objectContaining({ visibility: "secret" }),
		);
	});
});
