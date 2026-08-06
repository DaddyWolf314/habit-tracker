import { z } from "zod";
import { metadataValueSchema, roleSchema } from "./roles.ts";

/**
 * Rules (handoff §4.3): `when event.type = X [AND metadata constraints]
 * [AND ambient state] → effects`.
 *
 * The condition language stays deliberately small. It may test what the event
 * carries, who it is about, and what was *running* when it happened — never a
 * count, an elapsed time, or a query over the log (ADR 0011). An absent metadata
 * key ⇒ conditional rules silently skip (load-bearing for adjudication).
 */

/**
 * A numeric comparison on a metadata key (ADR 0011) — `mood <= 2`. **Not** a
 * state query: still a pure fold over the event, the same complexity class as
 * the equality it stands in for.
 *
 * The right-hand side is always a literal. A clause naming a second key
 * (`duration_ms > planned_ms`) would be computation, and rules route values
 * rather than computing them. Legal only on a `number` field, refused at
 * creation otherwise ({@link validateRule}).
 */
export const comparisonClauseSchema = z.object({
	op: z.enum(["lt", "lte", "gt", "gte"]),
	value: z.number(),
});
export type ComparisonClause = z.infer<typeof comparisonClauseSchema>;

/**
 * One constraint on a metadata key: equality against a literal, or a
 * {@link comparisonClauseSchema}. The comparison replaces the value on the same
 * map rather than living in a parallel one, so a key can never carry two
 * contradictory constraints — `{ mood: 3 }` beside `{ mood: { op: "gt", value: 4 } }`
 * would be valid, unsatisfiable, and silent forever.
 */
export const conditionClauseSchema = z.union([
	metadataValueSchema,
	comparisonClauseSchema,
]);
export type ConditionClause = z.infer<typeof conditionClauseSchema>;

/** Narrows a condition clause to a comparison; anything else is an equality. */
export function isComparisonClause(
	clause: ConditionClause,
): clause is ComparisonClause {
	return typeof clause === "object" && clause !== null && "op" in clause;
}

export const ruleConditionSchema = z.object({
	type: z.string(),
	/**
	 * Subject-role qualifier (ADR 0003): the rule matches only when the event's
	 * subject resolves to this role. Role form only — pack-portable, resolved
	 * against the couple's member roles at evaluation time; the engine never
	 * sees member ids. Absent ⇒ matches regardless of subject. Still a fact about
	 * the event itself, never a state query.
	 */
	subject_role: roleSchema.optional(),
	/** Constraints on composite metadata. Empty ⇒ matches on type alone. */
	metadata: z.record(z.string(), conditionClauseSchema).default({}),
	/**
	 * Ambient-state predicate (ADR 0011) — the one state query the language
	 * admits, and the extension #48 reserved. Maps a **timer definition** to
	 * whether an instance of it must be open: `{ denial_period: true }` matches
	 * while a denial is running, `{ session_stopwatch: false }` only outside a
	 * session. Empty ⇒ matches regardless of ambient state.
	 *
	 * Bounded on purpose. It names a definition, never an instance (there is no
	 * `match_on` — "is *a* `task_countdown` open", not "is this task's"), and it
	 * is boolean: no count, no remaining time, no comparison against a deadline.
	 * The map form is equality on a derived boolean, which keeps it the same
	 * complexity class as the metadata equality beside it.
	 *
	 * Resolved by the *caller* into `RuleEventContext.active_timers`, exactly as
	 * `subject_role` is, so the engine stays storage-free and the client's
	 * confirm-sheet preview agrees with the DO.
	 *
	 * Optional rather than defaulted (unlike `metadata`, which predates it and is
	 * near-universal): absent is the honest shape for the rules that have no
	 * ambient constraint, which is all of them but one. Read it through
	 * {@link ambientClauses} so the three consumers agree on that.
	 */
	timer_active: z.record(z.string(), z.boolean()).optional(),
	/**
	 * The score predicate (ADR 0015) — `{ demerits: { op: "gte", value: 10 } }`.
	 * Maps a **counter definition** to a {@link comparisonClauseSchema} over its
	 * value, so the language gains a map rather than an expression grammar: the
	 * same clause ADR 0011 admitted for metadata, pointed at a projection.
	 *
	 * ADR 0011 refused counter thresholds *pending #47* rather than on principle,
	 * on the grounds that an escalation ladder was the scoring layer wearing a
	 * condition-language costume. #47 decided that a ladder splits in two — a
	 * crossing is surfaced to people, and escalation is ordinary rules that read
	 * the score — so the costume comes off and the clause is admitted on its own
	 * terms. Nothing else on that refusal list moves.
	 *
	 * Two semantics are load-bearing, and both are the engine's, not the caller's
	 * to reinterpret:
	 *
	 * **The clock is evaluation-time** — log-time on append, ruling-time on
	 * re-evaluation. A counter's past value *is* reconstructible (every move
	 * traces `from`/`to`), but those rows are stamped at `logged_at`, never at
	 * `occurred_at`, and deliberately: an `occurred_at` reading would let a
	 * backfill change what a rule saw for an already-processed event, so a rebuild
	 * would diverge from live and ADR 0012's invariant would break silently.
	 *
	 * **It reads the score before this event's own effects.** One pass, over the
	 * state as it stood before the event landed — exactly as `timer_active` sees a
	 * denial period as active while the rule beside it closes that very denial as
	 * failed. So the infraction that crosses 10 does not escalate itself; the next
	 * one does.
	 *
	 * Resolved by the *caller* into `RuleEventContext.counter_values`, like
	 * `timer_active` and `subject_role`, so the engine stays storage-free and the
	 * dom's confirm-sheet preview and the DO agree by construction. Read it
	 * through {@link counterClauses}.
	 */
	counter_value: z.record(z.string(), comparisonClauseSchema).optional(),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

/**
 * A condition's ambient-state clauses, as entries. The one place the
 * absent-means-unconstrained reading lives, so the engine, the validator, and
 * the describer cannot drift on what a missing `timer_active` means.
 */
export function ambientClauses(condition: RuleCondition): [string, boolean][] {
	return Object.entries(condition.timer_active ?? {});
}

/**
 * A condition's score clauses, as entries (ADR 0015) — the `counter_value`
 * counterpart to {@link ambientClauses}, and here for the same reason: the
 * engine, the validator, and the describer must not drift on what an absent map
 * means.
 */
export function counterClauses(
	condition: RuleCondition,
): [string, ComparisonClause][] {
	return Object.entries(condition.counter_value ?? {});
}

/** A ref match, e.g. `timer.task_id = event.task_id`, expressed as timer→event keys. */
const matchOnSchema = z.record(z.string(), z.string());

/**
 * The dispositions a *rule* may close a timer with — and so, exactly the closes
 * a replay can re-derive from the log.
 *
 * That second reading is load-bearing, which is why this is a named export
 * rather than an inline enum. `rebuildCounters` resets precisely these before
 * replaying and preserves every other disposition, because the others
 * (`expired`, `canceled`, `auto_closed`) are written by a sweep or a dom command
 * and no event records them (ADR 0012). Deriving that reset list from here means
 * adding a verb-writable status cannot silently leave the rebuild resetting the
 * wrong set — the failure the timer projection has already had five times.
 */
export const timerCloseStatusSchema = z.enum(["completed", "failed"]);
export type TimerCloseStatus = z.infer<typeof timerCloseStatusSchema>;
/** The same set as a plain array, for binding into the rebuild's reset query. */
export const TIMER_CLOSE_STATUSES: readonly TimerCloseStatus[] =
	timerCloseStatusSchema.options;

/**
 * A **routed magnitude** (ADR 0015): the metadata key whose number becomes a
 * counter effect's amount, so "+2 for a major infraction" is one rule rather than
 * one rule per severity. Routing, not computation — the same shape `open_timer`'s
 * `duration_from` already uses, and the rule still never calculates anything.
 *
 * Present ⇒ it **replaces** `by` rather than seeding it. `by` carries a schema
 * default of 1, so there is no post-parse way to tell "author wrote by: 1" from
 * "author wrote nothing", and falling back to it when the routed value is missing
 * would make the trace read `+1` for a rule its author believed was proportional.
 * The effect skips instead (see `resolveEffect`).
 *
 * The key must name a field declared `integer: true` ({@link validateRule}), so a
 * `2.5` can never reach an integer counter. The *absent* case cannot move to
 * authoring time — a validly-declared field may be optional and left blank — and
 * is handled at runtime, once, in the engine.
 */
const byFromSchema = z.string().optional();

/**
 * Effect verbs — the complete v1 set. Rules route values; they never compute
 * them. Multiple effects per rule (effects is a list).
 */
export const effectSchema = z.discriminatedUnion("verb", [
	z.object({
		verb: z.literal("increment_counter"),
		counter: z.string(),
		// Integer only — counter values are integers (counterSchema.value.int()); a
		// fractional `by` would drive the cache non-integer and break reads/export.
		by: z.number().int().default(1),
		by_from: byFromSchema,
	}),
	z.object({
		verb: z.literal("decrement_counter"),
		counter: z.string(),
		by: z.number().int().default(1),
		by_from: byFromSchema,
	}),
	z.object({ verb: z.literal("reset_counter"), counter: z.string() }),
	z.object({ verb: z.literal("reset_anchor"), anchor: z.string() }),
	z.object({
		verb: z.literal("open_timer"),
		timer: z.string(),
		match_on: matchOnSchema.optional(),
		/** A fixed tag for the opened timer. */
		tag: z.string().optional(),
		/** Route an event metadata value as the tag (e.g. `activity`). Routing, not a literal. */
		tag_from: z.string().optional(),
		/**
		 * Route an event metadata number as the countdown duration in ms from
		 * assignment (e.g. `task_assigned`'s `duration_ms`). Its presence makes the
		 * opened timer a *countdown* (deadline `occurred_at + duration_ms`) rather
		 * than a stopwatch. Routing, not a literal — the rule never computes the value.
		 */
		duration_from: z.string().optional(),
	}),
	z.object({
		verb: z.literal("close_timer"),
		timer: z.string(),
		match_on: matchOnSchema.optional(),
		status: timerCloseStatusSchema,
		/**
		 * The counter the timer's derived duration is routed into on close (e.g.
		 * R16 → `service_minutes_week`). The duration is computed by the timer
		 * projection; the rule only says where it lands — it never computes a value.
		 */
		route_duration_to: z.string().optional(),
		/** Optional gate on the duration routing, e.g. only when `activity=service`. */
		route_when: z.record(z.string(), metadataValueSchema).optional(),
	}),
	/** v1: highlighted item in the today view (handoff R18). */
	z.object({
		verb: z.literal("notify"),
		target: z.enum(["partner"]).default("partner"),
	}),
]);
export type Effect = z.infer<typeof effectSchema>;

/**
 * The mutable definition of a rule — what it matches and what it does. Shared by
 * the flat read shape ({@link ruleSchema}) and one effective-dated revision
 * ({@link ruleVersionSchema}) so the two can never drift: a `Rule` is just a
 * definition with a stable id, and a `RuleVersion` is a definition stamped with
 * the log-time it takes force.
 */
export const ruleDefinitionSchema = z.object({
	/**
	 * What the couple calls this rule (#150, ADR 0009). It sits on the *definition*
	 * — and so on every version — rather than on the identity row, so a rename
	 * takes force from the moment it is made and never rewrites what a past
	 * revision or change notice said the rule was called.
	 *
	 * Optional because a rule can predate the name: every version written before
	 * v11 has none, and the engine never needed one. Read it through
	 * {@link ruleName}, never directly — an unnamed rule still has to render.
	 */
	name: z.string().optional(),
	condition: ruleConditionSchema,
	effects: z.array(effectSchema).min(1),
	enabled: z.boolean().default(true),
});
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

/**
 * A rule as the engine reads it: a stable id plus a single flattened definition.
 * This is the shape {@link evaluateRules} consumes and the resolver
 * (`rulesEffectiveAt`) produces for a given log-time — the versioned history
 * collapses to exactly this for the common read path (ADR 0002).
 */
export const ruleSchema = ruleDefinitionSchema.extend({ id: z.string() });
export type Rule = z.infer<typeof ruleSchema>;

/** Whether a rule shipped in the default pack (R#) or the couple authored it. */
export const ruleOriginSchema = z.enum(["pack", "custom"]);
export type RuleOrigin = z.infer<typeof ruleOriginSchema>;

/**
 * One effective-dated revision in a rule's append-only history (ADR 0002).
 * Editing a rule appends a version; prior versions are retained read-only so old
 * events replay under the definition that was in force when they were logged.
 */
export const ruleVersionSchema = ruleDefinitionSchema.extend({
	/**
	 * The log-time from which this version is in force — when the edit entered the
	 * log, never an event's `occurred_at`. The version applied to an event is the
	 * latest one whose `effective_from` is at or before that event's log-time.
	 */
	effective_from: z.number(),
});
export type RuleVersion = z.infer<typeof ruleVersionSchema>;

/**
 * A rule with its full revision history — the stored, editable shape (ADR 0002).
 * A stable `id` carries one or more append-only {@link ruleVersionSchema} entries;
 * `origin` distinguishes a default-pack rule from a custom one, and `adopted`
 * marks a pack rule the couple has edited (frozen against future pack overwrites).
 * Flattening the version in force at a log-time yields a plain {@link ruleSchema}.
 */
export const versionedRuleSchema = z.object({
	id: z.string(),
	origin: ruleOriginSchema,
	/** A pack rule the couple has edited — frozen against future pack overwrites. */
	adopted: z.boolean().default(false),
	/**
	 * An adopted rule whose shipped default now differs from the couple's edited
	 * definition (#64, user story 33). Set by pack reconciliation, cleared when the
	 * couple next edits the rule — it drives the "new default available" notice,
	 * never an overwrite.
	 */
	upstream_changed: z.boolean().optional(),
	/** Append-only revisions, ascending by `effective_from`. Never empty. */
	versions: z.array(ruleVersionSchema).min(1),
});
export type VersionedRule = z.infer<typeof versionedRuleSchema>;

/**
 * A rule's identity-and-provenance triple — what the `rules` row carries beside
 * the versioned history: the stable id, whether it shipped in the pack, and
 * whether the couple has adopted it. Travels together through every authoring
 * write, so it is one type rather than three loose parameters.
 */
export interface RuleIdentity {
	id: string;
	origin: RuleOrigin;
	adopted: boolean;
}

/**
 * Stamps a rule id onto one of its versions to produce the flat {@link Rule} the
 * engine reads and {@link validateRule} checks. This is the single seam between
 * the stored versioned history and the version-agnostic read path: the resolver
 * uses it to flatten the version in force at a log-time, and the edit path uses
 * it so a proposed new version is validated identically to a create.
 */
export function ruleFromVersion(id: string, version: RuleVersion): Rule {
	return {
		id,
		name: version.name,
		condition: version.condition,
		effects: version.effects,
		enabled: version.enabled,
	};
}

/**
 * The inverse of {@link ruleFromVersion}: stamps a definition with the log-time
 * it takes force, producing one append-only revision. Every writer of a version
 * — create, edit, enable/disable, pack reconciliation — goes through this so the
 * version shape has exactly one author.
 */
export function versionFromDefinition(
	definition: RuleDefinition,
	effectiveFrom: number,
): RuleVersion {
	return {
		effective_from: effectiveFrom,
		name: definition.name,
		condition: definition.condition,
		effects: definition.effects,
		enabled: definition.enabled,
	};
}

/** A rule's current (latest) version — the greatest `effective_from`. */
export function latestVersion(rule: VersionedRule): RuleVersion {
	return rule.versions.reduce((a, b) =>
		b.effective_from >= a.effective_from ? b : a,
	);
}

/** A rule's current definition flattened to the shape the engine and UI read. */
export function currentRule(rule: VersionedRule): Rule {
	return ruleFromVersion(rule.id, latestVersion(rule));
}

/**
 * What to call a rule on a screen (#150, ADR 0009) — its authored name, or a
 * de-slugged id when it has none.
 *
 * The one place the fallback lives, because every surface that names a rule needs
 * it and four hand-rolled versions would drift: a version written before v11, a
 * change notice about a purged rule, and a `Rule` the engine assembled in memory
 * all arrive here nameless. The de-slug is a last resort, not a display strategy
 * — #150 rejected it as the permanent answer precisely because a stable id and
 * the behaviour it describes drift apart, and it reads as a lie once they have.
 * It is still a better answer than a blank heading.
 */
export function ruleName(rule: { id: string; name?: string }): string {
	return rule.name?.trim() || deslugRuleId(rule.id);
}

/** `custom-late-check-in` → "late check in"; `R2` → "R2". */
function deslugRuleId(id: string): string {
	const bare = id.replace(/^custom[-_]/, "");
	const words = bare.replace(/[-_]+/g, " ").trim();
	return words || id;
}
