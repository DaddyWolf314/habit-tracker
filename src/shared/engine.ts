import type { MetadataValue } from "./roles.ts";
import {
	type Rule,
	type RuleCondition,
	type RuleVersion,
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
 * The condition language is deliberately dumb: equality on `type` and metadata
 * keys only. An absent key makes a conditional rule *silently skip* — this is
 * load-bearing for adjudication (a pending orgasm's `permitted` is unset, so
 * R11/R12 wait rather than fire), and every such skip surfaces as a near-miss.
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
 * The version in force at `logTime`: the one with the greatest `effective_from`
 * at or before it. Returns `undefined` when every version begins after `logTime`
 * (the rule did not yet exist). Order-independent — versions need not be sorted.
 */
function versionInForceAt(
	versions: RuleVersion[],
	logTime: number,
): RuleVersion | undefined {
	let chosen: RuleVersion | undefined;
	for (const version of versions) {
		if (version.effective_from > logTime) continue;
		if (!chosen || version.effective_from >= chosen.effective_from) {
			chosen = version;
		}
	}
	return chosen;
}

/** The slice of an event the engine reasons over: its type and composite state. */
export interface RuleEventContext {
	type: string;
	/** Composite metadata (original overlaid by amendments) — see projections.ts. */
	metadata: Record<string, MetadataValue>;
	/** Time-anchored effects (anchor resets) use `occurred_at`, not the log time. */
	occurred_at: number;
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
 *  - `fired`      — type matched and every metadata equality held.
 *  - `near_miss`  — type matched but a condition was unmet. `awaiting` lists the
 *    keys that were simply *unset* (the pending, resolve-on-adjudication case);
 *    a present-but-wrong value is a near-miss too but is not "waiting on"
 *    anything.
 */
export type MatchResult =
	| { status: "irrelevant" }
	| { status: "fired" }
	| { status: "near_miss"; reason: string; awaiting: string[] };

/** Tests a single rule's condition against an event's composite state. */
export function matchRule(rule: Rule, ctx: RuleEventContext): MatchResult {
	if (rule.condition.type !== ctx.type) return { status: "irrelevant" };
	return classifyMetadata(rule.id, rule.condition, ctx.metadata);
}

/** Compares a condition's metadata equalities against composite state. */
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
			awaiting.push(key);
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
		} else if (result.status === "near_miss" && isPending(result, ctx)) {
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
 * only ever *adds* effects. It never creates events; a correction that removes a
 * match does not un-fire prior effects (no retroactive surgery — the trace is an
 * honest record of what happened). The returned ops resolve against `after`, so
 * anchor resets carry the target's `occurred_at`, not the ruling time.
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
 * Whether a near-miss is worth surfacing: it is *pending* on a key the event
 * type is awaiting adjudication for. With no `awaiting` context, every near-miss
 * is surfaced (used by the pure pack tests). This is what keeps routine events —
 * a non-late ritual, a set-but-wrong value — from burying the trace in noise.
 */
function isPending(
	nearMiss: { awaiting: string[] },
	ctx: RuleEventContext,
): boolean {
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
			status?: "completed" | "failed";
			/** Counter the timer's derived duration is routed into on close. */
			route_duration_to?: string;
			/** Whether the (optional) routing gate held for this event. */
			route_when_met?: boolean;
	  }
	| { kind: "notify"; target: string };

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
			return {
				kind: "counter",
				counter: effect.counter,
				op: "increment",
				by: effect.by,
			};
		case "decrement_counter":
			return {
				kind: "counter",
				counter: effect.counter,
				op: "decrement",
				by: effect.by,
			};
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
 * A referenced key that is unset on the event is left out of the resolved match,
 * so an incomplete match resolves to *fewer* constraints, never the intended
 * ones. The Phase 4 timer matcher that consumes this must treat a match that
 * fails to pin a required key as "no matching timer → trace note" (handoff §4.5,
 * "ended with no matching started → reject"), NOT as "match any/all open timers".
 */
function resolveMatchOn(
	matchOn: Record<string, string> | undefined,
	ctx: RuleEventContext,
): Record<string, MetadataValue> | undefined {
	if (!matchOn) return undefined;
	const resolved: Record<string, MetadataValue> = {};
	for (const [timerKey, eventKey] of Object.entries(matchOn)) {
		const value = ctx.metadata[eventKey];
		if (value !== undefined) resolved[timerKey] = value;
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
