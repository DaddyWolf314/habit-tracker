import type { EventView } from "./events.ts";
import type { Visibility } from "./roles.ts";

/**
 * The single read-side visibility funnel (ADR 0001) — the first real
 * access-control rule inside the couple DO. Pure and dependency-light (like
 * `projections.ts`) so the DO and the client agree exactly on what a viewer may
 * see, and so it is unit-testable in plain Node.
 *
 * Every read path that can surface another member's journal entry —
 * `listEvents`, notification composition, and `exportData` — routes each event
 * through {@link viewFor} rather than re-deriving visibility inline. That keeps
 * the "secret is inert / sealed hides the words" contract in one auditable spot:
 * a secret entry is *omitted* for the non-author, a sealed entry appears with its
 * prose and typed metadata stripped, and a shared entry (or any always-shared
 * non-journaling event) passes through untouched. The author always sees their
 * own entry in full, at every level.
 */

/**
 * The outcome of funnelling one event for one viewer:
 *  - `hidden` — the viewer is not the author and the entry is `secret`; it must
 *    not appear at all, or its very existence would leak.
 *  - `visible` with `redacted: false` — the full view (author, shared entry, or
 *    any non-journaling event).
 *  - `visible` with `redacted: true` — a sealed entry seen by the non-author: the
 *    existence row survives (it can close an assignment and drive a projection)
 *    but the prose and typed metadata are gone.
 */
export type VisibilityOutcome =
	| { kind: "hidden" }
	| { kind: "visible"; redacted: boolean; view: EventView };

/**
 * Funnels a derived event view down to what `viewerId` is allowed to see. The
 * decision is a pure function of the entry's `visibility`, its `actor`, and the
 * viewer — never of how the redaction is computed. Non-journaling events are
 * always `shared`, so they pass straight through.
 */
export function viewFor(view: EventView, viewerId: string): VisibilityOutcome {
	const isAuthor = view.actor === viewerId;
	if (isAuthor || view.visibility === "shared") {
		return { kind: "visible", redacted: false, view };
	}
	if (view.visibility === "secret") {
		return { kind: "hidden" };
	}
	// sealed, non-author: the act is credited, the words are not.
	return { kind: "visible", redacted: true, view: redactSealed(view) };
}

/**
 * Convenience over {@link viewFor} for the log read model: the view a viewer
 * should see, or `null` when the entry is hidden from them entirely. Sealed
 * entries come back redacted; shared/own entries come back whole.
 */
export function visibleView(
	view: EventView,
	viewerId: string,
): EventView | null {
	const outcome = viewFor(view, viewerId);
	return outcome.kind === "hidden" ? null : outcome.view;
}

/**
 * Strips a sealed entry to its existence for a non-author: the prose (`note`) and
 * both the raw and composite typed metadata go, and the amendment list keeps only
 * the partner's own `response` gifts — never the author's `note_appended` context
 * or an adjudication note, which would leak the very words `sealed` withholds. The
 * derived `retracted` flag is preserved so a withdrawal still reads as withdrawn.
 */
function redactSealed(view: EventView): EventView {
	return {
		...view,
		note: undefined,
		metadata: {},
		composite_metadata: {},
		amendments: view.amendments.filter((a) => a.kind === "response"),
	};
}

/**
 * Whether a given visibility is legal for a type (ADR 0001): anything other than
 * `shared` is legal only on a journaling-capable type. The write path calls this
 * before persisting an event so a non-journaling type can never be marked
 * `sealed`/`secret` and slip prose out of the always-shared consent spine.
 */
export function visibilityAllowedForType(
	type: { journaling?: boolean },
	visibility: Visibility,
): boolean {
	return visibility === "shared" || type.journaling === true;
}
