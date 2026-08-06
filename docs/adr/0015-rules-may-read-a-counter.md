---
status: accepted
---

# Rules may read a counter

ADR 0011 admitted two clauses into the condition language and refused three. One
of the refusals was conditional rather than final:

> **Counter thresholds** (`demerits >= 10`). Rejected here: an escalation ladder
> is the scoring/rewards/consequences layer (#47) wearing a condition-language
> costume, and building it as rule conditions prejudges that decision.

That was the right call at the time and it deferred to a decision, not to a
principle. #47 is now decided, and the decision is that an escalation ladder
splits in two: a **crossing** is surfaced to people, and **escalation is ordinary
rules that read the score**. So the costume comes off, and the clause is admitted
on its own terms.

Nothing else in ADR 0011's refusal list moves. Elapsed-time comparison, log
lookback, and a timer's remaining time all stay refused, for the reasons given
there.

## A score is a counter

The layer mints no new primitive. `by` is already a weight — `R8: infraction AND
severity=major → demerits +2` is a weighted score and has been since the pack
shipped — and `valence` is already its direction. Multi-dimensional scoring falls
out of having more than one counter: `obedience`, `submission`, and `service` are
three counters, and one rule's effects list moves whichever of them the event
bears on.

What was missing is a **routed magnitude**. `by` is a literal, so a rule can say
"+2 for a major infraction" only by existing in one copy per severity. The
`open_timer` verb already routes a number off the event (`duration_from`), so the
precedent and its validation are both in place: `increment_counter` and
`decrement_counter` gain **`by_from`**, naming a metadata key whose value becomes
the magnitude.

This is routing, not computation. The rule still never calculates anything; it
says where a number the author wrote goes.

### The integer problem `by_from` exposes

`increment_counter.by` is `z.number().int()`, and its comment gives the reason: a
fractional `by` drives the counter cache non-integer and breaks reads and export.
But a `number` metadata field declares only `min` and `max` (`event-types.ts:53`),
so `by_from` could route `2.5` into an integer counter and validation as it stood
could not see it coming.

Number fields therefore gain an **`integer: true`** flag, and `validateRule`
refuses a `by_from` naming a field not declared integer. That puts the failure at
authoring time, where this repo has consistently put routing failures —
`checkRoutedKey` already refuses a `duration_from` naming a non-number field, for
the reason its comment gives: at runtime an absent key routes `undefined`, which
degrades the effect somewhere invisible instead of failing somewhere visible.

The **absent** case cannot be moved to authoring time, because a validly-declared
field may be optional and simply left blank. There, the effect **skips** and files
a trace note, the same shape the amendment path already writes when a timer op
finds its instance ended ("R14 skipped: denial_period already ended"). It does not
fall back to `by`, which would make the trace read `+1` for a rule its author
believed was proportional, and it does not round, which would invent a number
nobody wrote in a layer whose whole job is to be a truthful record.

## The clause

`counter_value` mirrors `timer_active` exactly, down to the resolution seam:

```
condition: {
  type: "infraction",
  counter_value: { demerits: { op: "gte", value: 10 } },
}
```

The value is a `comparisonClauseSchema` — the same one ADR 0011 admitted for
metadata — so the language gains a map, not an expression grammar. And like
`timer_active`, it is resolved by the **caller** into `RuleEventContext` rather
than read by the engine, which keeps the engine storage-free and keeps the dom's
confirm-sheet preview and the DO in agreement by construction.

### The clock is evaluation-time, and no other clock is available

A counter's past value *is* reconstructible: every counter move writes a trace row
carrying `from` and `to`, which is the durable equivalent of a timer's span. But
those rows are stamped at `event.logged_at`, or at an amendment's `created_at`
(`couple-do.ts:2775`) — never at `occurred_at`.

That is not an oversight to be corrected. Suppose the clause read the counter's
value as of the event's `occurred_at`. Then backfilling an event that happened
last Tuesday would change what a rule saw for an event already processed, and a
rebuild — which replays in log-time order — would compute a different result than
live did. ADR 0012's live-equals-rebuild invariant would break outright, and it
would break silently, which is the failure mode the timer projection has already
had five times.

So the clause reads the value **as the engine saw it when it acted**: log-time on
append, ruling-time on re-evaluation. This is the same clock ADR 0002 already
resolves rule *versions* against, which is a tidy result rather than a coincidence
— "what the machine did when it acted" is one question, and it deserves one clock.

The three clocks in the table ADR 0013 drew are unchanged. This adds a reader to
the first one.

### It reads the score before this event's own effects

A single evaluation pass, over the state as it stood before the event landed.

The precedent is exact and it is `timer_active`. R26 escalates an unpermitted
orgasm that happened during a denial period; R14, firing on the same event, closes
that very denial period as failed. The predicate sees the denial as **active**,
because the denial *was* running when the act happened. The score before the event
is the state the act happened against in precisely the same sense.

The consequence is worth stating plainly rather than discovering later: **the
infraction that crosses 10 does not escalate itself.** The next one does. The
person still sees the line being crossed the moment it is crossed, because the
crossing is surfaced (below) rather than left to a rule.

The alternative — a second pass for rules carrying a counter predicate, evaluated
against a snapshot of the post-effect state — is implementable and deterministic,
and it reads more like a person speaks ("that's your tenth"). It was declined
because it makes a rule carry a *phase*, and a phase is a concept the whole
condition language would then have to explain. One pass, one state, one reading.

## The mercy counterpart, and the counter it needed

Escalation without a decay path is a ratchet, and a ratchet is exactly the anxiety
mechanic the app's positioning refuses. So the layer needs some way to express
"this is the first infraction in thirty days".

The obvious route was an anchor clause — `elapsed_since`. It is refused, for three
reasons, and the third is the structural one:

- ADR 0003 already declined the neighbouring request ("fire only if the dom hasn't
  come since X") and its answer shipped as the queue card's evidence chips (#78).
- Elapsed computes a quantity that can be nonsense. Measured as `occurred_at`
  minus the anchor, it goes **negative** under backfill: an infraction logged today
  for last Tuesday, against an anchor reset yesterday by a later-occurring event,
  asks the rule to compare "−1 days since". Measured at log-time instead, the sign
  is safe and every backfilled event is silently over-credited with the delay.
  A counter needs one clock and has no such reading.
- An anchor's elapsed changes *continuously*, which invites the execution mode ADR
  0011 refused: "why doesn't it fire by itself on day 31" has no answer short of
  evaluating the rule set on a schedule. A counter moves only when an event moves
  it, so nothing invites it.

The intended workaround was to express a clean streak as a counter, and it did not
work: `daily_target` is `z.number().int().positive()` and a streak folds *target
met → +1*, so streaks could say "did at least N" and could not say "stayed at
zero". There was no clean-streak counter to read.

**So a target may be a cap as well as a floor.** A counter declares whether its
target is met by reaching it or by staying under it, which makes a target of `0`
meaningful and legal, and makes "31 consecutive days with no infraction" an
ordinary integer counter that `counter_value` reads like any other. No second
clock, no sign problem, no new clause. The streak machinery ADR 0013 rebuilt
already folds it.

## Rungs live on the counter and mean what an Agreement says

A ladder needs to hold two things that resolve differently. The **number** must be
machine-readable. The **consequence** is a term the couple agreed, and ADR 0006
exists so that agreed terms live in the consent corpus rather than in engine
config — a couple must not be able to change what a demerit costs without it
showing up as a change to a term.

So the counter definition carries `rungs: [{ at, agreement_ref }]`, and each half
resolves on the clock it already has: the number with the counter, the wording at
the citing event's `occurred_at` (ADR 0006). Renegotiating a consequence never
rewrites what a past crossing announced.

### Which amends ADR 0013's scope

ADR 0013 gave counter definitions a third clock and justified it precisely:

> a counter's policy is not read by an event at all. It is read by a *system job*,
> so the moment that governs is the period being folded.

Rungs break that premise — they are read when a counter **moves**, which is
event-driven. And the boundary clock cannot serve them, because a `reset: never`
counter like `demerits` or `infractions_lifetime` has no rollover boundary to
resolve at. A rung version therefore resolves at the **log-time of the counter
move** that crossed it.

This is the same principle ADR 0013 stated, applied to a second reader rather than
a new clock: the version in force when the reader read it. The rollover fold still
resolves at the boundary. One definition, two readers, each asking at the moment
it actually asks.

## A crossing is a recorded moment, not a debt

Crossing a rung upward writes a trace row, and a banner shows for as long as the
counter sits at or above the rung. History can say "you crossed 10 on Tuesday";
the banner clears when the counter drops by reset, acknowledgment, or decrement.

It is deliberately **not** an item someone closes. ADR 0007 pulls the other way —
only a person may close a conversation flag, because the app cannot observe a
conversation — but the closer precedent is #182 and the Response: a Response is
"a gift, not a debt", never tracked as pending or owed, and #182 chose
`awaiting: []` for an act on the grounds that asserting a verdict nobody asked for
is the *less* truthful record. An open crossing asserts an obligation the app
cannot verify was discharged. It stays a fact, not a ledger entry.

The row is rebuildable, because counter moves replay and the rung version resolves
off the same log-time the replay is already walking.

**Both partners see rungs and distance identically.** Handoff §8's "no countdowns,
no anxiety mechanics" governs pressure the *app* invents — the queue deliberately
shows the dom a time-in-queue and shows the sub nothing of the kind. A ladder is a
term the couple consented to, and concealing its state from the person it binds
would make the consent record asymmetric in the one direction it must never be.

**A crossing raises the content-free notification count for both members.** It is
the only thing this layer produces that is not already addressed to someone: a
bare logged event notifies nobody, so without this a crossing reaches the dom only
when the underlying event happens to be pending a ruling.

## Consequences

- `ruleConditionSchema`, `RuleEventContext`, `matchRule`, `validateRule`, and
  `rule-describe` change together, as they did for ADR 0011. The describer must
  render the clause in the couple's voice ("while demerits are 10 or more"),
  because the confirm sheet and the chain view share its phrasing.
- The client's preview must be shipped the couple's **counters** alongside the
  rules and timers it already receives, or the confirm sheet and the DO will
  disagree on a `counter_value` clause.
- A near-miss on a `counter_value` clause follows the ambient-state rule: no ruling
  can resolve it, so it never enters `awaiting`, and it is surfaced only when it
  was the sole miss.
- `counterDefinitionSchema` gains a target direction and `rungs`; both version with
  the rest of the definition under ADR 0013.
- `traceDetailSchema` gains a crossing kind, and `notifications.ts` gains a source.
- The pack ships **no default rungs**. A consequence ladder is a term a couple
  agrees; shipping one would be the app asserting a consequence nobody consented
  to, which is the same objection ADR 0006 raised against default Agreements.
- A reversal (ADR 0016) can drop a counter back below a rung. The recorded crossing
  stays, because it happened; the banner clears, because the derived state is
  false. Nothing re-fires: reversal applies ops and never evaluates rules.
- Reversal also makes a past `counter_value` evaluation stale — an event evaluated
  last week saw a score that has since been corrected downward. Forward-only stands
  (ADR 0016): the past keeps the consequences it received. Replay reproduces it
  exactly, because the reversal sits at its own position in log order and later
  events replay against the reduced value just as they did live.
