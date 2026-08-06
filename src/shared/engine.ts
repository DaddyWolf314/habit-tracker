import { versionInForceAt } from "./effective-dating.ts";
import type { MetadataValue, Role } from "./roles.ts";
import {
	ambientClauses,
	type ComparisonClause,
	counterClauses,
	isComparisonClause,
	type Rule,
	type RuleCondition,
	ruleFromVersion,
	type VersionedRule,
} from "./rules.ts";

/**
 * The rule engine (handoff §4.3) — a pure, dependency-free fold from an event to
 * the projection changes it causes and the rules that *nearly* fired. Kept free
 * of any storage or runtime dependency so the Durable Object and the client
 * agree exactly and it is unit-testable in plain Node, exactly like
 * `projections.ts`. The DO calls this on append (and on replay/rebuild); it
 * never creates events (no cascades, no loops — the log's integrity as a consent
 * record is preserved).
 *
 * The condition language stays small: it may test what the event carries, who it
 * is about, and what was *running* when it happened — never a count, an elapsed
 * time, or a query over the log (ADR 0011). An absent metadata key makes a
 * conditional rule *silently skip* — this is load-bearing for adjudication (a
 * pending orgasm's `permitted` is unset, so R11/R12 wait rather than fire), and
 * every such skip surfaces as a near-miss.
 *
 * The two state queries, `timer_active` and `counter_value`, do not breach the
 * no-storage rule: the *caller* resolves which timer definitions are open and
 * what each counter holds and passes them in
 * ({@link RuleEventContext.active_timers}, {@link RuleEventContext.counter_values}),
 * exactly as it resolves `subject_role`.
 */

/**
 * Effective-dated resolution (ADR 0002, spec #64). Collapses the couple's
 * versioned rule history to the flat rule set in force at a given **log-time** —
 * the time an event entered the log (or a rule edit did), never an event's
 * `occurred_at`. For each rule it selects the latest version whose
 * `effective_from` is at or before `logTime`; a rule whose earliest version
 * begins after `logTime` did not yet exist and is omitted.
 *
 * The result is a plain `Rule[]` that {@link evaluateRules} / {@link reevaluate}
 * consume unchanged, so the version-aware seam sits entirely here: a rebuild
 * passes each event's log-time through this and *reproduces* history rather than
 * re-deriving it under today's rules, and a late adjudication resolves the
 * version that was in force when the target event was logged — never a newer one.
 *
 * A version disabled from `T` is still *resolved* for events logged before `T`
 * (the earlier, enabled version wins) and, at or after `T`, resolves to an
 * `enabled: false` rule that `evaluateRules` then skips — so disabling stays a
 * forward-only, effective-dated state change, not a retroactive un-firing.
 */
export function rulesEffectiveAt(
	rules: VersionedRule[],
	logTime: number,
): Rule[] {
	const resolved: Rule[] = [];
	for (const rule of rules) {
		const version = versionInForceAt(rule.versions, logTime);
		if (!version) continue; // Rule did not exist yet at this log-time.
		resolved.push(ruleFromVersion(rule.id, version));
	}
	return resolved;
}

/**
 * No timer of any definition is open — the ambient state for an evaluation that
 * has none to speak of: a rules-screen description, a pure unit test, a preview
 * built before the timers have loaded. Shared so those callers state the
 * assumption once rather than minting an empty set each time.
 */
export const NO_ACTIVE_TIMERS: ReadonlySet<string> = new Set<string>();

/**
 * No counter has a resolved value — the score for an evaluation that has none to
 * speak of, and the {@link NO_ACTIVE_TIMERS} counterpart for `counter_value`
 * (ADR 0015). A rule carrying no score clause is unaffected either way; one that
 * does will read every clause as unmet, which is the honest answer when nobody
 * has said what the counters hold.
 */
export const NO_COUNTER_VALUES: ReadonlyMap<string, number> = new Map<
	string,
	number
>();

/** The slice of an event the engine reasons over: its type and composite state. */
export interface RuleEventContext {
	type: string;
	/** Composite metadata (original overlaid by amendments) — see projections.ts. */
	metadata: Record<string, MetadataValue>;
	/** Time-anchored effects (anchor resets) use `occurred_at`, not the log time. */
	occurred_at: number;
	/**
	 * The role the event's subject resolves to (ADR 0003), resolved by the caller
	 * via `resolveSubjectRole` — the engine stays member-id-free. Undefined when
	 * the event has no subject (or the subject's role is unconfirmed); a
	 * subject-qualified rule then never matches.
	 */
	subject_role?: Role;
	/**
	 * The timer **definitions** running at the event's moment, for the ambient-
	 * state predicate (ADR 0011). Resolved by the caller — both the DO and the
	 * client through `activeTimerDefinitionsAt`, over the spans each already holds
	 * — so the engine reads no storage and the confirm-sheet preview agrees with
	 * the DO by construction. Not `openTimerRows`: that is the `status IS NULL`
	 * question, which a rebuild's reset makes the wrong one.
	 *
	 * Required rather than optional, unlike `awaiting`: omitting `awaiting` only
	 * surfaces extra near-misses, whereas an omitted timer set would silently read
	 * as "nothing is running" and quietly under-fire every mode-scoped rule. The
	 * compiler is the guard the ADR asked for. Pass an empty set when a caller
	 * genuinely has no ambient state (a rule with no `timer_active` clause is
	 * unaffected either way).
	 */
	active_timers: ReadonlySet<string>;
	/**
	 * What each counter held **when the engine acted**, for the counter-value predicate
	 * (ADR 0015). Resolved by the caller — the DO from its counter cache, the
	 * client's confirm sheet from the counters it is shipped — so the engine reads
	 * no storage and the preview and the DO agree by construction.
	 *
	 * Two things this is *not*, both load-bearing:
	 *
	 * It is not a value as of `occurred_at`. Counter trace rows are stamped at
	 * `logged_at`, so an `occurred_at` reading would let a backfill change what an
	 * already-processed event saw and a rebuild would silently diverge from live
	 * (ADR 0012). The clock is log-time on append, ruling-time on re-evaluation.
	 *
	 * It is not a snapshot taken after this event's own effects. The caller builds
	 * this before applying anything the event causes, so a rule that both reads and
	 * increments `demerits` sees the value the act happened against — the same
	 * reading `timer_active` gives a denial period that the rule beside it is about
	 * to close.
	 *
	 * Required rather than optional, for the reason `active_timers` is: an omitted
	 * map would read as "no counter has a value" and quietly hold every score-gated
	 * rule shut. Pass {@link NO_COUNTER_VALUES} when a caller genuinely has none.
	 * A counter absent from the map is *unknown*, never zero — asserting a value
	 * for a counter nobody resolved is how a rule fires on a number that was never
	 * true.
	 */
	counter_values: ReadonlyMap<string, number>;
	/**
	 * The event type's `awaiting` keys (handoff §5). When provided, only near-
	 * misses that are *pending* on one of these keys are surfaced — a rule waiting
	 * on `permitted` is genuine pending-adjudication signal ("R11/R12 waiting on:
	 * permitted"), whereas one waiting on an optional key like `late`, or one that
	 * simply saw a wrong value, is noise. Omit to surface every near-miss.
	 */
	awaiting?: string[];
}

/**
 * The outcome of testing one rule against one event:
 *  - `irrelevant` — the event type doesn't match; the rule is not shown at all.
 *  - `fired`      — type matched, the subject-role qualifier (if any) held, and
 *    every metadata constraint and ambient-state clause held.
 *  - `near_miss`  — type matched but a condition was unmet. `awaiting` lists the
 *    keys that were simply *unset* (the pending, resolve-on-adjudication case);
 *    a present-but-wrong value is a near-miss too but is not "waiting on"
 *    anything. `subject_mismatch` marks a near-miss on the subject-role
 *    qualifier (ADR 0003): structural — the subject is fixed at logging, so the
 *    rule can never fire on this event, and no adjudication is awaited.
 *    `state_mismatch` marks one on the ambient-state predicate (ADR 0011) or the
 *    counter-value predicate (ADR 0015): no ruling on any key resolves either, so
 *    neither is ever `awaiting`. One flag for both, because it names *why* the
 *    near-miss is unresolvable rather than which clause raised it — a rule that
 *    misses on both files one row saying both things.
 */
export type MatchResult =
	| { status: "irrelevant" }
	| { status: "fired" }
	| {
			status: "near_miss";
			reason: string;
			awaiting: string[];
			subject_mismatch?: boolean;
			state_mismatch?: boolean;
	  };

/**
 * The near-miss arm of {@link MatchResult}, named so the predicates over it read
 * one field list rather than restating it structurally — the last two flags were
 * each added in two places.
 */
type NearMissMatch = Extract<MatchResult, { status: "near_miss" }>;

/** Tests a single rule's condition against an event's composite state. */
export function matchRule(rule: Rule, ctx: RuleEventContext): MatchResult {
	if (rule.condition.type !== ctx.type) return { status: "irrelevant" };
	// Subject-role qualifier (ADR 0003): checked before metadata because a
	// mismatch is terminal — the subject never changes, so metadata "waiting on"
	// keys would be a false promise ("R12 waiting on: permitted" for an event it
	// can never fire on). A dom/sub qualifier in a switch/switch couple lands
	// here on every event: dormant by design.
	const wanted = rule.condition.subject_role;
	if (wanted !== undefined && ctx.subject_role !== wanted) {
		return {
			status: "near_miss",
			reason: `${rule.id} didn't fire: subject is not the ${wanted}`,
			awaiting: [],
			subject_mismatch: true,
		};
	}
	// Metadata first, the caller-resolved predicates second — the order the
	// near-miss depends on. A miss on either of those is only worth a trace row
	// when it was the *sole* reason (ADR 0011, carried forward by ADR 0015), so a
	// rule that also missed on metadata reports the metadata: that is the part a
	// reader can act on. The converse would file "no denial period was active"
	// against every routine event of the type.
	const metadata = classifyMetadata(rule.id, rule.condition, ctx.metadata);
	if (metadata.status !== "fired") return metadata;
	// Both predicates in one row rather than one chained after the other: they
	// raise the same fact ("the rule would have fired, but the world wasn't in the
	// shape it asked for"), and a rule missing on both should say both rather than
	// report the timer and go quiet about the counter.
	const unmet = [
		...unmetAmbientState(rule.condition, ctx),
		...unmetCounterValues(rule.condition, ctx),
	];
	if (unmet.length === 0) return { status: "fired" };
	// Never `awaiting`: no ruling on any metadata key will make a denial period
	// have been running or make the counter have stood at 10, so promising the
	// adjudication queue a resolution would be a lie.
	return {
		status: "near_miss",
		reason: `${rule.id} didn't fire: ${unmet.join(", ")}`,
		awaiting: [],
		state_mismatch: true,
	};
}

/**
 * The ambient-state predicate's unmet clauses (ADR 0011) — `timer_active`, read
 * against the timer definitions the caller resolved as open.
 */
function unmetAmbientState(
	condition: RuleCondition,
	ctx: RuleEventContext,
): string[] {
	const unmet: string[] = [];
	for (const [timer, wanted] of ambientClauses(condition)) {
		if (ctx.active_timers.has(timer) === wanted) continue;
		unmet.push(wanted ? `${timer} not active` : `${timer} active`);
	}
	return unmet;
}

/**
 * The counter-value predicate's unmet clauses (ADR 0015) — read against the
 * counter values the caller resolved.
 */
function unmetCounterValues(
	condition: RuleCondition,
	ctx: RuleEventContext,
): string[] {
	const unmet: string[] = [];
	for (const [counter, clause] of counterClauses(condition)) {
		const value = ctx.counter_values.get(counter);
		// Unknown, not zero. A counter the caller didn't resolve — deleted since the
		// rule was authored, or simply not shipped to this surface — has no value to
		// compare, and inventing 0 would fire "while demerits are under 5" on a
		// counter nobody read. Reported in the same shape as a value that missed, so
		// the trace row distinguishes the two without a second grammar.
		if (value === undefined) {
			unmet.push(`${counter} is unknown, needs ${describeComparison(clause)}`);
			continue;
		}
		if (satisfies(value, clause)) continue;
		unmet.push(`${counter} is ${value}, needs ${describeComparison(clause)}`);
	}
	return unmet;
}

/** Compares a condition's metadata constraints against composite state. */
function classifyMetadata(
	ruleId: string,
	condition: RuleCondition,
	metadata: Record<string, MetadataValue>,
): MatchResult {
	const awaiting: string[] = [];
	const mismatched: string[] = [];
	for (const [key, expected] of Object.entries(condition.metadata)) {
		const actual = metadata[key];
		if (actual === undefined) {
			// Unset ⇒ awaiting, for a comparison exactly as for an equality: the
			// pending-adjudication case is about the key being absent, not about
			// which constraint would have been applied to it.
			awaiting.push(key);
		} else if (isComparisonClause(expected)) {
			// A non-numeric value can only reach here on a type whose schema changed
			// under a rule validated against the old one; it fails the comparison
			// rather than coercing, so the rule goes quiet instead of scoring on a
			// string. Creation-time validation is what keeps this unreachable.
			if (typeof actual !== "number" || !satisfies(actual, expected)) {
				mismatched.push(
					`${key} is ${format(actual)}, needs ${describeComparison(expected)}`,
				);
			}
		} else if (actual !== expected) {
			mismatched.push(`${key} is ${format(actual)}, needs ${format(expected)}`);
		}
	}
	if (awaiting.length === 0 && mismatched.length === 0) {
		return { status: "fired" };
	}
	const parts = [...awaiting.map((key) => `${key} not set`), ...mismatched];
	return {
		status: "near_miss",
		reason: `${ruleId} didn't fire: ${parts.join(", ")}`,
		awaiting,
	};
}

function format(value: MetadataValue): string {
	return typeof value === "string" ? value : String(value);
}

/** Whether a numeric metadata value satisfies a comparison clause (ADR 0011). */
function satisfies(actual: number, clause: ComparisonClause): boolean {
	switch (clause.op) {
		case "lt":
			return actual < clause.value;
		case "lte":
			return actual <= clause.value;
		case "gt":
			return actual > clause.value;
		case "gte":
			return actual >= clause.value;
	}
}

/**
 * A comparison in near-miss prose. Terse and symbolic, matching the rest of the
 * engine's reasons, which are read in the trace beside a rule id — the couple's
 * voice ("2 or less") is `rule-describe`'s job, not this one's.
 */
function describeComparison(clause: ComparisonClause): string {
	const symbol = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[clause.op];
	return `${symbol} ${clause.value}`;
}

/** A rule that fired, with the projection ops it produced (see resolveEffect). */
export interface FiredRule {
	rule_id: string;
	ops: EffectOp[];
}

/** A rule that matched on type but whose condition was unmet — recorded in trace. */
export interface NearMiss {
	rule_id: string;
	reason: string;
	/** Keys that were unset (vs. set-but-wrong); drives "waiting on: …" in the UI. */
	awaiting: string[];
}

export interface Evaluation {
	fired: FiredRule[];
	nearMisses: NearMiss[];
}

/**
 * Evaluates the full enabled rule set against one event. Disabled rules are
 * skipped entirely; relevant rules land in exactly one of `fired` / `nearMisses`
 * (irrelevant-type rules appear in neither). Fired rules carry their resolved
 * projection ops so the caller only has to apply them.
 */
export function evaluateRules(
	rules: Rule[],
	ctx: RuleEventContext,
): Evaluation {
	const fired: FiredRule[] = [];
	const nearMisses: NearMiss[] = [];
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		const result = matchRule(rule, ctx);
		if (result.status === "fired") {
			fired.push({
				rule_id: rule.id,
				ops: rule.effects.map((effect) => resolveEffect(effect, ctx)),
			});
		} else if (result.status === "near_miss" && isSurfaced(result, ctx)) {
			nearMisses.push({
				rule_id: rule.id,
				reason: result.reason,
				awaiting: result.awaiting,
			});
		}
	}
	return { fired, nearMisses };
}

/**
 * Re-evaluation on amendment (handoff §4.2, §7). When a ruling changes an
 * event's composite state, the engine re-runs over the *target* event and fires
 * the rules that match now but did *not* match before — never re-firing what
 * already fired at append time (or under an earlier ruling), so an adjudication
 * only ever *adds* effects. It never creates events. The returned ops resolve
 * against `after`, so anchor resets carry the target's `occurred_at`, not the
 * ruling time.
 *
 * **This stays forward-only, and reversal is computed beside it** (ADR 0016).
 * A correction that removes a match leaves this returning nothing for that rule;
 * {@link unfired} names it instead, and the caller reverses what the *trace*
 * records actually fired. Making re-evaluation bidirectional was the obvious
 * alternative and was declined: the effects it would hand back are re-derived
 * from a rule definition that may have been edited since (ADR 0002), which is not
 * the same set as the one that landed. #184 pinned the limit this replaces.
 */
export function reevaluate(
	rules: Rule[],
	before: RuleEventContext,
	after: RuleEventContext,
): FiredRule[] {
	const firedBefore = new Set(
		evaluateRules(rules, before).fired.map((f) => f.rule_id),
	);
	return evaluateRules(rules, after).fired.filter(
		(f) => !firedBefore.has(f.rule_id),
	);
}

/**
 * The reversal counterpart to {@link reevaluate} (ADR 0016): the rules that
 * fired in `before` and no longer fire in `after` — a correction's "these
 * effects are now attached to a fact that is no longer true".
 *
 * Returns **rule ids only, never effects**, and that is the whole point of it
 * being a separate function rather than a flag on `reevaluate`. Whether a rule
 * still matches is a question about the *condition*, which is safe to ask of
 * today's resolved rule set; what it did when it fired is a question about the
 * *effects*, which is not — the definition may have been edited since, so the
 * caller reads that from the trace. Keeping the two apart in the signature is
 * what stops a future caller from re-deriving effects here by accident.
 */
export function unfired(
	rules: Rule[],
	before: RuleEventContext,
	after: RuleEventContext,
): string[] {
	const firedAfter = new Set(
		evaluateRules(rules, after).fired.map((f) => f.rule_id),
	);
	return evaluateRules(rules, before)
		.fired.map((f) => f.rule_id)
		.filter((id) => !firedAfter.has(id));
}

/**
 * Whether a near-miss is worth surfacing: it is *pending* on a key the event
 * type is awaiting adjudication for. With no `awaiting` context, every near-miss
 * is surfaced (used by the pure pack tests). This is what keeps routine events —
 * a non-late ritual, a set-but-wrong value — from burying the trace in noise.
 *
 * A subject-role mismatch (ADR 0003) is always surfaced, awaiting filter or
 * not: it is structural, not transient — the whole family of rules qualified
 * for the other role went dormant on this event, and the consent-record view
 * must be able to answer "why didn't the sub's orgasm rules fire" on a
 * dom-subject orgasm without a debugger.
 *
 * An ambient-state mismatch (ADR 0011) is always surfaced too, and `matchRule`
 * has already done the filtering that earns it: it is only ever reported when
 * every other clause held, so the row says the one thing worth knowing — this
 * rule would have fired if the mode had been on. A sub reading the ledger can
 * see that the denial escalation was considered and why it stayed out.
 */
function isSurfaced(nearMiss: NearMissMatch, ctx: RuleEventContext): boolean {
	if (nearMiss.subject_mismatch || nearMiss.state_mismatch) return true;
	if (ctx.awaiting === undefined) return true;
	return nearMiss.awaiting.some((key) => ctx.awaiting?.includes(key));
}

// ── Effect resolution (handoff §4.3 — "rules route values, never compute them")

/**
 * A normalized projection mutation produced by a fired effect. This is the
 * *routing* — where a value goes — never the value's computation. Counter ops
 * apply live in Phase 3; anchor/timer/notify ops are traced now and their
 * projection state machines land in Phase 4 (timers + alarms).
 */
export type EffectOp =
	| {
			kind: "counter";
			counter: string;
			op: "increment" | "decrement" | "reset";
			by?: number;
	  }
	| { kind: "anchor"; anchor: string; at: number }
	| {
			kind: "timer";
			timer: string;
			op: "open" | "close";
			match_on?: Record<string, MetadataValue>;
			tag?: string;
			/**
			 * The routed countdown duration (ms from assignment) on an `open`, from the
			 * effect's `duration_from`. Present ⇒ open a *countdown* with deadline
			 * `occurred_at + duration_ms`; absent ⇒ a stopwatch. The rule routes this
			 * value off the event; it never computes it.
			 */
			duration_ms?: number;
			status?: "completed" | "failed";
			/** Counter the timer's derived duration is routed into on close. */
			route_duration_to?: string;
			/** Whether the (optional) routing gate held for this event. */
			route_when_met?: boolean;
	  }
	| { kind: "notify"; target: string }
	/**
	 * An effect that resolved to **nothing** (ADR 0015): a `by_from` whose key was
	 * absent from the event, or carried a value that is not a whole number. The
	 * projection is untouched and a trace note is filed, the shape the amendment
	 * path already writes for a timer op whose instance has ended.
	 *
	 * A distinct `kind` rather than a flag on the counter op, because that is what
	 * makes the compiler ask every consumer what it does with one. It deliberately
	 * does *not* fall back to `by` — which would print `+1` for a rule its author
	 * believed was proportional — and it does not round, which would invent a
	 * number nobody wrote in a layer whose whole job is to be a truthful record.
	 */
	| {
			kind: "skipped";
			/** The counter that would have moved — where the note lands. */
			counter: string;
			op: "increment" | "decrement";
			/** The `by_from` key that routed nothing usable. */
			key: string;
	  };

/** A rule-driven counter op (narrowed helper below). */
type CounterOp = Extract<EffectOp, { kind: "counter" }>;

/**
 * Folds a rule-driven counter op onto a running value. Shared by the DO's live
 * application and its from-scratch rebuild, so the materialized counter cache is
 * provably a cache. `by` defaults to 1, matching the effect schema.
 */
export function applyCounterOp(value: number, op: CounterOp): number {
	switch (op.op) {
		case "increment":
			return value + (op.by ?? 1);
		case "decrement":
			return value - (op.by ?? 1);
		case "reset":
			return 0;
	}
}

/** Resolves one effect to its projection op given the event context. */
export function resolveEffect(
	effect: Rule["effects"][number],
	ctx: RuleEventContext,
): EffectOp {
	switch (effect.verb) {
		case "increment_counter":
			return resolveCounterDelta(effect, "increment", ctx);
		case "decrement_counter":
			return resolveCounterDelta(effect, "decrement", ctx);
		case "reset_counter":
			return { kind: "counter", counter: effect.counter, op: "reset" };
		case "reset_anchor":
			// Time-anchored: uses the event's occurred_at, not the log/ruling time.
			return { kind: "anchor", anchor: effect.anchor, at: ctx.occurred_at };
		case "open_timer":
			return {
				kind: "timer",
				timer: effect.timer,
				op: "open",
				match_on: resolveMatchOn(effect.match_on, ctx),
				tag: effect.tag_from
					? asString(ctx.metadata[effect.tag_from])
					: effect.tag,
				duration_ms: effect.duration_from
					? asNumber(ctx.metadata[effect.duration_from])
					: undefined,
			};
		case "close_timer":
			return {
				kind: "timer",
				timer: effect.timer,
				op: "close",
				match_on: resolveMatchOn(effect.match_on, ctx),
				status: effect.status,
				route_duration_to: effect.route_duration_to,
				route_when_met: routeGateMet(effect.route_when, ctx),
			};
		case "notify":
			return { kind: "notify", target: effect.target };
	}
}

/**
 * Resolves a counter delta, routing its magnitude off the event when the effect
 * asks for one (`by_from`, ADR 0015). Shared by the two delta verbs so increment
 * and decrement can never diverge on what a missing routed value means.
 *
 * `by_from` **replaces** `by`; it never seeds it. Three cases, one of which is
 * the whole reason this function exists:
 *
 *  - no `by_from` — the literal `by`, exactly as before.
 *  - a whole number at the key — that number is the magnitude.
 *  - anything else (key absent, blank, a string, a fraction, a NaN) — a
 *    {@link EffectOp} of kind `skipped`. The absent case is the one that cannot
 *    move to authoring time, because a validly-declared integer field may be
 *    optional and simply left blank; the rest are unreachable through
 *    `validateRule` and refused here anyway rather than trusted.
 */
function resolveCounterDelta(
	effect: Extract<
		Rule["effects"][number],
		{ verb: "increment_counter" | "decrement_counter" }
	>,
	op: "increment" | "decrement",
	ctx: RuleEventContext,
): EffectOp {
	// The target is resolved first, because a skip has to say which counter it did
	// not move and an unrouted target leaves that question unanswerable. Refused at
	// authoring time (`validateRule` demands a `required` ref field), so reaching
	// the skip here means the event carried a blank where the schema promised a
	// value — a can't-happen guard, filed rather than trusted.
	const counter = resolveCounterTarget(effect, ctx);
	if (counter === undefined) {
		// Unreachable through `validateRule`, which demands `counter_from` name a
		// *required* ref field — so a blank here means the event carried nothing
		// where the schema promised a value. The row names the **key** rather than a
		// counter, because there is no counter to name: writing an empty projection
		// id would put a blank where a person reads one.
		return {
			kind: "skipped",
			counter: effect.counter_from ?? "?",
			op,
			key: effect.counter_from ?? "?",
		};
	}
	if (effect.by_from === undefined) {
		return { kind: "counter", counter, op, by: effect.by };
	}
	const routed = asNumber(ctx.metadata[effect.by_from]);
	if (routed === undefined || !Number.isInteger(routed)) {
		return { kind: "skipped", counter, op, key: effect.by_from };
	}
	return { kind: "counter", counter, op, by: routed };
}

/**
 * The counter a delta effect moves: the literal `counter`, or the one its
 * `counter_from` names on the event (ADR 0017).
 *
 * `counter_from` **replaces** `counter`, on the reasoning `by_from` states for a
 * magnitude — a fallback would move a counter the rule's author did not name, and
 * moving the wrong tally is worse than moving none. Undefined when the routing
 * found nothing usable, which the caller turns into a skip.
 */
function resolveCounterTarget(
	effect: Extract<
		Rule["effects"][number],
		{ verb: "increment_counter" | "decrement_counter" }
	>,
	ctx: RuleEventContext,
): string | undefined {
	if (effect.counter_from === undefined) return effect.counter;
	const routed = asString(ctx.metadata[effect.counter_from]);
	return routed === undefined || routed === "" ? undefined : routed;
}

/**
 * Routes a closed timer's *derived duration* into its target counter (handoff
 * §4.3, R16). The duration is computed by the timer projection on close and
 * supplied here — the rule only says where it lands, so it never computes a
 * value. Returns null when the close has no duration target or its routing gate
 * (e.g. `activity=service`) didn't hold for this event.
 */
export function routeClosedTimerDuration(
	op: EffectOp,
	duration: number,
): EffectOp | null {
	if (op.kind !== "timer" || op.op !== "close" || !op.route_duration_to) {
		return null;
	}
	if (op.route_when_met === false) return null;
	return {
		kind: "counter",
		counter: op.route_duration_to,
		op: "increment",
		by: duration,
	};
}

/**
 * Resolves a ref match like `timer.session_id = event.session_id` (expressed as
 * `{ session_id: "session_id" }`) into concrete values pulled from the event —
 * the routing that lets a close find the matching open.
 *
 * A referenced key that is unset on the event voids the *whole* match: the
 * resolved value is `{}`, which the Phase 4 timer matcher treats as "no matching
 * timer → trace note" (handoff §4.5, "ended with no matching started →
 * reject"). Dropping only the unset key would leave a match with *fewer*
 * constraints and let a close grab an open timer it never referenced — an
 * incomplete reference must orphan, never widen. (`undefined` — a rule with no
 * `match_on` at all — stays the singleton close.)
 */
function resolveMatchOn(
	matchOn: Record<string, string> | undefined,
	ctx: RuleEventContext,
): Record<string, MetadataValue> | undefined {
	if (!matchOn) return undefined;
	const resolved: Record<string, MetadataValue> = {};
	for (const [timerKey, eventKey] of Object.entries(matchOn)) {
		const value = ctx.metadata[eventKey];
		if (value === undefined) return {};
		resolved[timerKey] = value;
	}
	return resolved;
}

/** Whether an optional duration-routing gate (e.g. `activity=service`) holds. */
function routeGateMet(
	when: Record<string, MetadataValue> | undefined,
	ctx: RuleEventContext,
): boolean | undefined {
	if (!when) return undefined;
	return Object.entries(when).every(
		([key, value]) => ctx.metadata[key] === value,
	);
}

function asString(value: MetadataValue | undefined): string | undefined {
	return value === undefined ? undefined : format(value);
}

/**
 * Routes a metadata value as a number (a countdown's `duration_ms`). Unlike
 * {@link asString} this never *coerces* — a non-numeric value (a string, a
 * boolean, a NaN/Infinity) yields undefined so the opened timer falls back to a
 * stopwatch rather than a garbage deadline. The rule routes the value; it never
 * parses or computes one.
 */
function asNumber(value: MetadataValue | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}
