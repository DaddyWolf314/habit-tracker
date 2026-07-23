import { z } from "zod";
import { metadataValueSchema, roleSchema } from "./roles.ts";

/**
 * Rules (handoff §4.3): `when event.type = X [AND metadata equality] → effects`.
 *
 * The condition language is deliberately dumb — equality on `type`, metadata
 * keys, and the subject's role only. Absent key ⇒ conditional rules silently
 * skip (load-bearing for adjudication). No expressions, thresholds, or state
 * queries in v1.
 */
export const ruleConditionSchema = z.object({
	type: z.string(),
	/**
	 * Subject-role qualifier (ADR 0003): the rule matches only when the event's
	 * subject resolves to this role. Role form only — pack-portable, resolved
	 * against the couple's member roles at evaluation time; the engine never
	 * sees member ids. Absent ⇒ matches regardless of subject. Still equality
	 * on the event itself, never a state query.
	 */
	subject_role: roleSchema.optional(),
	/** Equality conditions on composite metadata. Empty ⇒ matches on type alone. */
	metadata: z.record(z.string(), metadataValueSchema).default({}),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

/** A ref match, e.g. `timer.task_id = event.task_id`, expressed as timer→event keys. */
const matchOnSchema = z.record(z.string(), z.string());

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
	}),
	z.object({
		verb: z.literal("decrement_counter"),
		counter: z.string(),
		by: z.number().int().default(1),
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
	}),
	z.object({
		verb: z.literal("close_timer"),
		timer: z.string(),
		match_on: matchOnSchema.optional(),
		status: z.enum(["completed", "failed"]),
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
