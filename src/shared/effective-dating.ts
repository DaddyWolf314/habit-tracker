/**
 * Effective-dating (CONTEXT §Effective-dating) — the one mechanism behind every
 * append-only versioned definition in the app, shared so the four things that
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
 *  - **Reward item versions** resolve at the redeeming event's **`occurred_at`**
 *    (ADR 0017) — a redemption's `reward_ref` is a citing ref, so it lands on the
 *    Agreement clock rather than minting a fourth one. Four definitions, three
 *    clocks: the count that matters is *readers*, not definitions.
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

/**
 * The last version written, by `effective_from` — which is **not** the one in
 * force: a version dated ahead is the announced change, latest while governing
 * nothing yet.
 *
 * Retiring reads this rather than {@link versionInForceAt}, because a retirement
 * has to land after *every* existing version or a pending change would later
 * resolve past it and quietly un-retire the definition. Shared for the reason the
 * resolver is: it was written identically for Agreements and for reward items,
 * and two copies of a tie-break this subtle eventually disagree.
 */
export function latestVersionOf<T extends EffectiveDated>(versions: T[]): T {
	let latest = versions[0];
	for (const version of versions) {
		if (version.effective_from >= latest.effective_from) latest = version;
	}
	return latest;
}

/**
 * Why a proposed `effective_from` is illegal for a new version, or null when it
 * is fine. `noun` names the thing in the refusal ("an agreement can't be
 * backdated"), which is the only part that differed between the two copies.
 *
 * **Forward-only** is the guarantee every versioned definition rests on. A
 * version dated into the past would disturb what a resolved citation already
 * read — an infraction about last week resolving against text written today, or
 * a redemption already made re-priced — which is the defect effective-dating
 * exists to prevent, reached from the other direction.
 *
 * Dating a version *ahead* is fine and is the point: that is the announced
 * change, visible to both and governing nothing yet. It must still land after
 * every existing version, or a pending one would resolve past it.
 */
export function forwardOnlyRefusal(
	proposed: number | undefined,
	existing: readonly EffectiveDated[],
	now: number,
	noun: string,
): string | null {
	if (proposed === undefined) return null;
	if (proposed < now) {
		return `${noun} can't be backdated — it takes force from now on`;
	}
	for (const version of existing) {
		if (proposed <= version.effective_from) {
			return "a version already takes force at or after that moment";
		}
	}
	return null;
}
