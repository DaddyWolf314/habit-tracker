import { z } from "zod";
import { versionInForceAt } from "./effective-dating.ts";
import { permissionListSchema, valenceSchema } from "./roles.ts";

/**
 * Counters (handoff §4.4) — materialized tallies derived from the event log.
 * The stored value is a *cache* for cheap reads and live sync; it is always
 * rebuildable by replaying the log (see `projections.ts`). In Phase 2 the only
 * thing that moves a counter is direct manipulation (`counter_adjusted` /
 * `counter_reset` events); the rule pack that drives them from real events
 * lands in Phase 3.
 */

/**
 * Reset semantics, a first-class counter property (handoff §4.4):
 *  - `never`            — accumulates forever (lifetime tallies).
 *  - `daily` / `weekly` — cleared on a schedule; the firing alarm is Phase 4,
 *    so in Phase 2 the cadence is stored but only event-driven resets apply.
 *  - `on_acknowledgment`— cleared when acknowledged (a `counter_reset` event).
 *  - `manual`           — cleared by hand, with a note (a `counter_reset` event).
 */
export const counterResetSchema = z.enum([
	"never",
	"daily",
	"weekly",
	"on_acknowledgment",
	"manual",
]);
export type CounterReset = z.infer<typeof counterResetSchema>;

/**
 * Which way a target is met (ADR 0015):
 *  - `floor` — met by *reaching* it (`value >= target`). The original reading,
 *    and what every counter written before this flag existed meant.
 *  - `cap`   — met by *staying under* it (`value <= target`), which is what makes
 *    a target of `0` mean something: "a day with no infractions".
 *
 * The direction is what turns a streak into a mercy path rather than a ratchet.
 * ADR 0015 refused an `elapsed_since` clause — it computes a quantity that goes
 * negative under backfill and changes continuously — on the grounds that "the
 * first infraction in thirty days" is expressible as a counter a `counter_value`
 * clause reads. It was not, while a target could only be a floor: a streak folds
 * *target met → +1*, so counters could say "did at least N" and never "stayed at
 * zero". One enum, and the clean streak is an ordinary integer counter.
 */
export const targetDirectionSchema = z.enum(["floor", "cap"]);
export type TargetDirection = z.infer<typeof targetDirectionSchema>;

/**
 * One rung of a consequence ladder (ADR 0015) — a threshold, and what the couple
 * agreed crossing it means.
 *
 * The two halves are split because they resolve differently. The **number** has
 * to be machine-readable, so it lives here and versions with the counter (ADR
 * 0013). The **consequence** is a term the couple agreed, and ADR 0006 exists so
 * that agreed terms live in the consent corpus rather than in engine config: a
 * couple must not be able to change what a demerit costs without it showing as a
 * change to a term. So the rung *cites* an Agreement and carries no prose of its
 * own, and the wording resolves at the citing moment's `occurred_at` like every
 * other citation. Renegotiating a consequence never rewrites what a past crossing
 * announced.
 *
 * `at` is not policed beyond being a whole number. A rung at or below where a
 * counter starts simply never gets crossed, which is meaningless rather than
 * dangerous — the same nothing a floor of 0 is.
 */
export const counterRungSchema = z.object({
	at: z.number().int(),
	/** The Agreement whose term says what crossing this rung costs. */
	agreement_ref: z.string().min(1),
});
export type CounterRung = z.infer<typeof counterRungSchema>;

/** The stored definition of a counter (its identity and policy, not its value). */
export const counterDefinitionSchema = z.object({
	id: z.string(),
	name: z.string().min(1),
	valence: valenceSchema.default("neutral"),
	// Non-negative rather than positive (ADR 0015): a cap of `0` is the whole
	// point of the direction below, and refusing it here would leave the mercy
	// path unexpressible. A *floor* of 0 is legal and trivially always met, which
	// is meaningless rather than dangerous — the same nothing an absent target is.
	daily_target: z.number().int().nonnegative().optional(),
	weekly_target: z.number().int().nonnegative().optional(),
	/**
	 * Which way this counter's targets are met (ADR 0015). Applies to both
	 * targets — a counter is one kind of thing, and a daily floor beside a weekly
	 * cap describes no counter anybody wants.
	 *
	 * Defaulted rather than optional so `targetMet` reads one shape: every counter
	 * written before the flag existed meant `floor`, and a default states that
	 * once here rather than at each of the three call sites that fold a target.
	 */
	target_direction: targetDirectionSchema.default("floor"),
	reset: counterResetSchema.default("never"),
	/**
	 * Marks this counter as a streak of another target-counter (handoff §4.4 —
	 * "streaks are built into target-counters, not rules"). At each `period`
	 * rollover the alarm reads `counter`'s target-met and folds this streak
	 * `+1 : 0`. Absent for ordinary counters.
	 */
	streak: z
		.object({
			counter: z.string(),
			period: z.enum(["daily", "weekly"]).default("daily"),
		})
		.optional(),
	/**
	 * The consequence ladder (ADR 0015): the thresholds this counter announces
	 * when it crosses them going up. Versioned with the rest of the definition
	 * (ADR 0013), and read at the **log-time of the counter move** that crossed
	 * one — which is a second reader of the same definition, not a fourth clock.
	 * ADR 0013 justified the boundary clock on the premise that "a counter's policy
	 * is not read by an event at all"; rungs break it, and the boundary could not
	 * serve them anyway, since a `reset: never` counter has no rollover boundary.
	 *
	 * Empty by default, and the pack ships none: what a demerit costs is a term the
	 * couple agreed, so a shipped rung would be the app asserting a consequence
	 * nobody consented to — the objection ADR 0006 raised against default
	 * Agreements.
	 */
	rungs: z.array(counterRungSchema).default([]),
	/** Roles permitted to adjust or reset the counter directly (handoff §4.4). */
	modify_permission: permissionListSchema.default(["dom", "sub", "switch"]),
});
export type CounterDefinition = z.infer<typeof counterDefinitionSchema>;

/** What a client sends to create a counter; the id is derived from the name. */
export const createCounterInputSchema = counterDefinitionSchema
	.omit({ id: true })
	.extend({ id: z.string().optional() });
/** Parsed shape (defaults applied) — what the DO receives. */
export type CreateCounterInput = z.infer<typeof createCounterInputSchema>;
/** Wire shape (defaults optional) — what a client may send. */
export type CreateCounterBody = z.input<typeof createCounterInputSchema>;

/**
 * What a client sends to edit a counter. The `id` is the stable key that events
 * reference, so it is fixed by the path and never taken from the body — only the
 * policy fields change. The value is untouched (it is a cache the log rebuilds).
 */
export const updateCounterInputSchema = counterDefinitionSchema.omit({
	id: true,
});
/** Parsed shape (defaults applied) — what the DO receives. */
export type UpdateCounterInput = z.infer<typeof updateCounterInputSchema>;
/** Wire shape (defaults optional) — what a client may send. */
export type UpdateCounterBody = z.input<typeof updateCounterInputSchema>;

/** A counter as returned to clients: its definition plus the cached value. */
export const counterSchema = counterDefinitionSchema.extend({
	value: z.number().int(),
	updated_at: z.number().int().nullable(),
});
export type Counter = z.infer<typeof counterSchema>;

// ── Effective-dated definitions (ADR 0013) ───────────────────────────────────

/**
 * One version of a counter's policy, taking force at `effective_from`.
 *
 * Everything but the `id` versions, for the reason ADR 0009 gave for rule names:
 * a counter's history is *displayed*, so a name on the identity row would
 * retroactively rewrite what a past trace row said the counter was called.
 */
export const counterVersionSchema = counterDefinitionSchema
	.omit({ id: true })
	.extend({ effective_from: z.number().int() });
export type CounterVersion = z.infer<typeof counterVersionSchema>;

/** A counter's stable identity and its full version history. */
export interface VersionedCounter {
	id: string;
	versions: CounterVersion[];
}

/** A version of a counter's policy, flattened back to a definition. */
export function counterFromVersion(
	id: string,
	version: CounterVersion,
): CounterDefinition {
	const { effective_from: _effectiveFrom, ...definition } = version;
	return { id, ...definition };
}

/**
 * A definition stamped as the version taking force at `effectiveFrom`.
 *
 * Derived by parsing through {@link counterVersionSchema} rather than copying
 * fields across by hand, so a field added to `counterDefinitionSchema` versions
 * itself. A hand-written literal here would silently drop the new field from
 * every version written — the same rot the rebuild's status list avoids by
 * binding `TIMER_CLOSE_STATUSES` to the rule schema's own enum (ADR 0012).
 *
 * Any `id` on the input is stripped: the id is the stable identity, not policy.
 */
export function versionFromCounterDefinition(
	definition: Omit<CounterDefinition, "id"> & { id?: string },
	effectiveFrom: number,
): CounterVersion {
	return counterVersionSchema.parse({
		...definition,
		effective_from: effectiveFrom,
	});
}

/**
 * Whether two versions carry the same policy, ignoring when each took force.
 * What decides if an edit is a real edit: a pack bump rewrites every default
 * counter, and appending a version for one whose policy is unchanged would be
 * history recording that nothing happened.
 */
export function sameCounterPolicy(
	a: CounterVersion,
	b: CounterVersion,
): boolean {
	const policy = ({ effective_from: _ignored, ...rest }: CounterVersion) =>
		rest;
	return JSON.stringify(policy(a)) === JSON.stringify(policy(b));
}

/**
 * The counter policies in force at `atMs` — the seam a rebuild resolves history
 * through, exactly as `rulesEffectiveAt` is for rules (ADR 0013).
 *
 * **The clock is the rollover boundary**, which is neither of the two clocks
 * `effective-dating.ts` already names. A rule version resolves at an event's
 * log-time (the machine acted); an Agreement version resolves at `occurred_at`
 * (the person was bound). A counter's policy is read by a *system job* — the
 * daily or weekly rollover — so the moment that governs is the boundary being
 * folded, not any event's. That is what lets a replay fold each past period
 * against the target that was actually in force for it, instead of scoring the
 * couple's whole history against whatever the target says today.
 *
 * A counter whose earliest version begins after `atMs` did not exist yet and is
 * omitted, so a rollover replayed from before a counter was created folds
 * nothing for it.
 */
export function countersEffectiveAt(
	counters: VersionedCounter[],
	atMs: number,
): CounterDefinition[] {
	const resolved: CounterDefinition[] = [];
	for (const counter of counters) {
		const version = versionInForceAt(counter.versions, atMs);
		if (!version) continue;
		resolved.push(counterFromVersion(counter.id, version));
	}
	return resolved;
}

/**
 * The counter values a rule's `counter_value` clause reads (ADR 0015), keyed by
 * id — the resolution seam for the counter-value predicate, and the counterpart
 * to `activeTimerDefinitionsAt` for the ambient-state one.
 *
 * Shared for the reason the ADR gives: the dom's confirm-sheet preview and the DO
 * must agree "by construction". They read from different shapes — the client from
 * a `Counter`, the DO from its `counters` row — so the parameter is the pair both
 * carry rather than either whole type, and neither surface gets to build the map
 * its own way.
 *
 * The *clock* is still the caller's: this folds whatever values it is handed, and
 * it is the caller's job to hand over the ones in force when the engine acts (see
 * {@link RuleEventContext.counter_values}).
 */
export function counterValuesOf(
	counters: readonly { id: string; value: number }[],
): ReadonlyMap<string, number> {
	return new Map(counters.map((counter) => [counter.id, counter.value]));
}

// ── Rungs: crossings and distance (ADR 0015) ─────────────────────────────────

/**
 * The rungs a move from `from` to `to` crossed, lowest first.
 *
 * **Upward only.** A crossing is the moment a line was passed, and passing it
 * going down is not a moment — it is the counter being where it now is, which
 * the banner already says. Downward would also announce the same rung twice for
 * one round trip, so a reset to zero would file a "crossed 10" on the way back
 * up *and* on the way down.
 *
 * Open on the low side and closed on the high: landing exactly on 10 crosses the
 * rung at 10, and a later move that starts at 10 does not cross it again. That is
 * what makes "crossed 10, reset to 0, crossed 10 again" two rows and not three.
 *
 * A single move may cross several rungs — `+5` over rungs at 3 and 5 — and each
 * gets its own row, because each names a different term the couple agreed.
 */
export function rungsCrossed(
	rungs: readonly CounterRung[],
	from: number,
	to: number,
): CounterRung[] {
	if (to <= from) return [];
	return rungs
		.filter((rung) => rung.at > from && rung.at <= to)
		.sort((a, b) => a.at - b.at);
}

/**
 * The rungs a counter currently sits at or above, **highest first** — the state
 * the banner renders (ADR 0015).
 *
 * Derived from the value rather than from the crossing rows, which is what makes
 * the banner clear by itself when the counter drops by reset, acknowledgment,
 * decrement, or a reversal (ADR 0016). The recorded crossing stays, because it
 * happened; the banner goes, because the derived state is false.
 */
export function rungsReached(
	rungs: readonly CounterRung[],
	value: number,
): CounterRung[] {
	return rungs.filter((rung) => value >= rung.at).sort((a, b) => b.at - a.at);
}

/** Payload for a direct +N / −N adjustment (the "+1 tap" sugar). */
export const adjustCounterInputSchema = z.object({
	delta: z.number().int(),
	note: z.string().max(500).optional(),
});
export type AdjustCounterInput = z.infer<typeof adjustCounterInputSchema>;

/** Payload for a manual/acknowledgment reset. */
export const resetCounterInputSchema = z.object({
	note: z.string().max(500).optional(),
});
export type ResetCounterInput = z.infer<typeof resetCounterInputSchema>;
