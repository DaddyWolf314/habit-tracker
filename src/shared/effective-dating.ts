/**
 * Effective-dating (CONTEXT §Effective-dating) — the one mechanism behind every
 * append-only versioned definition in the app, shared so the three things that
 * use it cannot drift apart.
 *
 * A stable id carries versions, each stamped with the moment it takes force;
 * resolving asks "which version governed at time T". What differs between
 * consumers is *which clock T comes from*, and that difference is load-bearing:
 *
 *  - **Rule versions** resolve at an event's **log-time** (ADR 0002) — a rule
 *    version governs when the machine acted.
 *  - **Agreement versions** resolve at an event's **`occurred_at`** (ADR 0006) —
 *    an Agreement version governs what the person was bound by when they acted.
 *  - **Counter versions** resolve at a **rollover boundary** (ADR 0013) — a
 *    counter's policy is read by a system job rather than by an event at all, so
 *    the moment that governs is the period being folded.
 *
 * The choice of clock is the semantics and stays with each caller. Picking the
 * version is mechanism and lives here, because the tie-break is subtle enough
 * that three copies of it would eventually disagree.
 */

/** The minimum a version must carry to be resolvable. */
export interface EffectiveDated {
	effective_from: number;
}

/**
 * The version in force at `atMs`: the one with the greatest `effective_from` at
 * or before it. Returns `undefined` when every version begins after `atMs` — the
 * definition did not yet exist, which is not the same as having no versions.
 * Order-independent: versions need not be sorted.
 */
export function versionInForceAt<T extends EffectiveDated>(
	versions: T[],
	atMs: number,
): T | undefined {
	let chosen: T | undefined;
	for (const version of versions) {
		if (version.effective_from > atMs) continue;
		if (!chosen || version.effective_from >= chosen.effective_from) {
			chosen = version;
		}
	}
	return chosen;
}
