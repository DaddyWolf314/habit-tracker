import { describe, expect, it } from "vitest";
import type { Amendment } from "./amendments.ts";
import type { Event } from "./events.ts";
import { deriveEventView } from "./projections.ts";
import type { Visibility } from "./roles.ts";
import {
	viewFor,
	visibilityAllowedForType,
	visibleView,
} from "./visibility.ts";

/**
 * The three-level gradient asserted as *observable behavior* (ADR 0001), matching
 * the read-model style of `export.test.ts` / `adjudication.test.ts`: we test what
 * a viewer sees, never how the redaction is computed.
 */

const AUTHOR = "sub-1";
const PARTNER = "dom-1";

function entry(
	visibility: Visibility,
	over: Partial<Event> = {},
	amendments: Amendment[] = [],
) {
	const event: Event = {
		id: "e1",
		type: "journal_entry",
		actor: AUTHOR,
		occurred_at: 10,
		logged_at: 10,
		metadata: { prompt_id: "p1" },
		note: "the private words",
		visibility,
		...over,
	};
	return deriveEventView(event, amendments, { awaiting: [] });
}

describe("viewFor — the author always sees their own entry whole", () => {
	for (const visibility of ["shared", "sealed", "secret"] as const) {
		it(`author sees full prose for a ${visibility} entry`, () => {
			const outcome = viewFor(entry(visibility), AUTHOR);
			expect(outcome.kind).toBe("visible");
			if (outcome.kind !== "visible") throw new Error("unreachable");
			expect(outcome.redacted).toBe(false);
			expect(outcome.view.note).toBe("the private words");
			expect(outcome.view.metadata).toEqual({ prompt_id: "p1" });
		});
	}
});

describe("viewFor — what the non-author partner sees", () => {
	it("shared: full prose passes through", () => {
		const outcome = viewFor(entry("shared"), PARTNER);
		expect(outcome).toMatchObject({ kind: "visible", redacted: false });
		if (outcome.kind !== "visible") throw new Error("unreachable");
		expect(outcome.view.note).toBe("the private words");
	});

	it("sealed: an existence row with prose and typed metadata redacted", () => {
		const outcome = viewFor(entry("sealed"), PARTNER);
		expect(outcome.kind).toBe("visible");
		if (outcome.kind !== "visible") throw new Error("unreachable");
		expect(outcome.redacted).toBe(true);
		// The row still exists (id/actor/visibility survive) — it can close an
		// assignment and drive a projection — but the words are gone.
		expect(outcome.view.id).toBe("e1");
		expect(outcome.view.visibility).toBe("sealed");
		expect(outcome.view.note).toBeUndefined();
		expect(outcome.view.metadata).toEqual({});
		expect(outcome.view.composite_metadata).toEqual({});
	});

	it("secret: nothing — the entry is hidden entirely", () => {
		expect(viewFor(entry("secret"), PARTNER)).toEqual({ kind: "hidden" });
		expect(visibleView(entry("secret"), PARTNER)).toBeNull();
	});
});

describe("viewFor — sealed redaction keeps the dom's own response, drops the sub's words", () => {
	const response: Amendment = {
		kind: "response",
		id: "r1",
		target_event_id: "e1",
		actor: PARTNER,
		created_at: 20,
		note: "proud of you",
	};
	const noteAppended: Amendment = {
		kind: "note_appended",
		id: "n1",
		target_event_id: "e1",
		actor: AUTHOR,
		created_at: 21,
		note: "more private words",
	};

	it("a non-author sees the response gift but not the author's appended prose", () => {
		const outcome = viewFor(
			entry("sealed", {}, [response, noteAppended]),
			PARTNER,
		);
		if (outcome.kind !== "visible") throw new Error("unreachable");
		expect(outcome.view.amendments).toHaveLength(1);
		expect(outcome.view.amendments[0]?.kind).toBe("response");
	});

	it("the author still sees everything on their own sealed entry", () => {
		const outcome = viewFor(
			entry("sealed", {}, [response, noteAppended]),
			AUTHOR,
		);
		if (outcome.kind !== "visible") throw new Error("unreachable");
		expect(outcome.redacted).toBe(false);
		expect(outcome.view.amendments).toHaveLength(2);
	});
});

describe("visibilityAllowedForType — non-shared gated to journaling types", () => {
	it("a non-journaling type rejects any non-shared visibility", () => {
		expect(visibilityAllowedForType({ journaling: false }, "shared")).toBe(
			true,
		);
		expect(visibilityAllowedForType({ journaling: false }, "sealed")).toBe(
			false,
		);
		expect(visibilityAllowedForType({ journaling: false }, "secret")).toBe(
			false,
		);
	});

	it("a journaling type allows all three levels", () => {
		expect(visibilityAllowedForType({ journaling: true }, "shared")).toBe(true);
		expect(visibilityAllowedForType({ journaling: true }, "sealed")).toBe(true);
		expect(visibilityAllowedForType({ journaling: true }, "secret")).toBe(true);
	});
});
