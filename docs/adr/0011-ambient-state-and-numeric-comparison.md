---
status: accepted
---

# The condition language gains numeric comparison and one ambient-state predicate

#48 reserved exactly one v2 extension to the rule condition language — a bounded
state predicate, `timer_active(X)` — and said twice not to generalize past it.
V1 is behind us and the reservation is now the thing to spend. This ADR spends
it, and pairs it with a second extension #48's language blocks by accident.

The two are different complexity classes and are decided together only because
they land in the same schema:

- **Ambient state** (`timer_active`) is what #48 reserved. It asks a question
  about the world at the moment of the event, not about the event.
- **Numeric comparison** is not a state query at all. It stays a pure fold over
  the event, exactly like the metadata equality already shipping.

Both stop well short of the three generalizations that keep getting proposed
alongside them — counter thresholds, elapsed-time comparison, and log lookback.
Those are refused here, on the record, so the next person to reach for them has
to argue rather than assume.

## What the condition language cannot say today

`evaluateRules` (`src/shared/engine.ts`) is a pure fold over one event: its type,
its composite metadata, and its subject's role. Two costs follow.

**Modes are unspeakable.** R12 gives a flat +2 demerits for an unpermitted
orgasm whether or not a `denial_period` is running. R14 closes that denial as
`failed`, so the engine plainly *knows* a denial was broken — it just cannot let
that change the score. The couple's only workaround is a metadata key the author
sets by hand, which means the sub self-reporting an infraction must also
correctly classify the ambient state they were in. Getting it wrong is silent:
the consequence is simply wrong, and nothing in the trace says so.

**Numbers are only testable for equality.** The pack ships two `number` fields,
`check_in.mood` and `task_assigned.duration_ms`, and a condition can say
`mood = 3` and nothing else. R18 notifies the dom when a check-in carries
`flag = wants_conversation` — so a sub having a bad day has to also *ask*, which
is precisely the thing that is hard when you are having a bad day. A `number`
field the language cannot compare is a field the pack is wasting.

## Decision

### Ambient state — `timer_active`

`ruleConditionSchema` gains an optional `timer_active`: a map of timer definition
id to expected activity, the same shape and the same complexity class as the
`metadata` equality map.

```ts
timer_active: z.record(z.string(), z.boolean()).optional(),
```

`{ denial_period: true }` matches while a denial is running; `{ session_stopwatch:
false }` matches only outside a session. The map form buys negation and
conjunction without inventing an expression grammar — it is equality, on a
derived boolean, and that is deliberately the whole of it.

Bounded means, concretely:

- It names a **timer definition**, never a timer instance. There is no
  `match_on` — the question is "is *a* `task_countdown` open", not "is the one
  belonging to this task open". The instance-scoped form is a real want and it is
  deferred, not smuggled in.
- It is a boolean. No count, no remaining time, no comparison against a
  countdown's deadline. "Is it running" is the entire vocabulary.
- Open means open. A timer that is `completed`, `failed`, `expired`, `canceled`,
  or `auto_closed` is not active. Read off the instance's *span* rather than its
  status — see "The predicate reads the span" below, which is where the first
  draft of this got it wrong.

### Numeric comparison

A condition's metadata entry may be a **comparison clause** instead of a bare
value:

```ts
{ op: "lt" | "lte" | "gt" | "gte", value: number }
```

So `{ mood: { op: "lte", value: 2 } }`. The right-hand side is always a literal.
A clause may never name another key: `duration_ms > planned_ms` is computation,
and "rules route values, they never compute them" still holds the line.

The clause replaces the value on the existing `metadata` map rather than living
in a second map of its own, so a single key carries a single constraint and
`{ metadata: { mood: 3 }, numeric: { mood: { gt: 4 } } }` — valid, unsatisfiable,
and silent forever — is unrepresentable.

## The engine stays storage-free; the caller resolves the state

This is the part that matters architecturally, and ADR 0003 already wrote the
pattern.

`engine.ts` is kept "free of any storage or runtime dependency so the Durable
Object and the client agree exactly" — not decoration, because
`queue-panel.tsx:previewEffects` re-runs `reevaluate` **in the browser** to show
the dom what their ruling is about to fire. An engine that reaches into SQL makes
that preview lie.

So `timer_active` resolves the way `subject_role` does: the **caller** resolves
it and passes the answer in. `RuleEventContext` gains

```ts
/** Timer definitions running at the event's moment, resolved by the caller. */
active_timers: ReadonlySet<string>;
```

and `CoupleDO.ruleContext` — already the single seam where `subject_role` and
`awaiting` are resolved — fills it via `activeTimerDefinitionsAt` over
`timerRows()`. (Not `openTimerRows`: that is the `status IS NULL` question, which
the next section explains is the wrong one.) The engine stays a pure function of
its context, the client previews correctly from the timers it already holds, and
the member-id-free discipline ADR 0003 established for roles extends unchanged to
timers.

## The predicate reads the span, not the status

`timer_active` resolves against each timer instance's durable **span** —
`opened_at <= at`, and `closed_at` either unset or later than `at` — never
against its current `status`. `activeTimerDefinitionsAt` in `shared/timers.ts` is
the single implementation; the DO and the client's preview both call it.

The naive version of this predicate ("which timers have `status IS NULL` right
now") was drafted first and is wrong, in a way worth recording because it is not
obvious:

- **It breaks rebuild, silently and in the scoring direction.**
  `rebuildCounters` resets rule-closed countdowns to running (`status = NULL`)
  before replaying, because only a countdown's event-driven close can be
  re-derived. A status test therefore reads `denial_period` as active from the
  very first replayed event, and R26 escalates unpermitted orgasms that predate
  the denial entirely. `opened_at` is never reset, so the span answers correctly.
- **It makes the predicate un-askable about the past**, which is what an
  amendment needs.

The span is durable, and it is honest about every way a timer ends: the sweep
stamps `closed_at` when a countdown expires, so an expiry closes the span
without the predicate having to reason about deadlines — which is the thing
pause and extend rewrite in place, and the reason "was this running last
Tuesday" looked unanswerable at first.

A **paused** countdown is active. Pausing freezes the clock; it does not end the
denial.

### The rebuild has to preserve the span for that to hold

Reading the span is only half the fix, and the first cut of this ADR missed the
other half. `rebuildCounters` cleared `status` **and** `closed_at` for *every*
countdown, on the reasoning that replay re-closes them. Replay only re-closes the
ones an event closed: `expired` is the sweep's and `canceled` is the dom's, both
off-log, and the rebuild never re-runs the sweeps. So those two came back with no
`closed_at` at all — an expired `denial_period` read as still running for every
later replayed event, and R26 escalated orgasms live evaluation had left alone.
The same rebuild-only, scoring-direction divergence the span was supposed to
close, moved one step down.

The reset is therefore scoped to the closes replay can re-derive:

```sql
UPDATE timers SET status = NULL, closed_at = NULL
  WHERE kind = 'countdown' AND status IN ('completed', 'failed')
```

**Stopwatches remain a known gap.** They are deleted and re-opened from the log,
so one the over-max sweep `auto_closed` — an ending no event records — comes back
open and stays open for the rest of the replay. Nothing in the pack conditions on
a stopwatch today, so no shipped rule is affected; closing it properly means
sweeping at each replayed event's timestamp rather than at `now`, which is a
change to how rebuild handles system jobs generally and not this ADR's to make.

## An amendment asks what was running then

Ambient state resolves as of the event's **`occurred_at`** — everywhere: append,
replay, amendment re-evaluation, and the confirm-sheet preview.

So a dom who rules `permitted: false` a week later still lands the escalation, if
the denial was running when the orgasm happened. That is the right answer on the
merits — the question a rule asks is what the person did, under what conditions,
at the time — and it puts ambient state on the same clock as the two things it
most resembles: an anchor reset (which uses the target's `occurred_at`, not the
ruling time) and a citing ref (which resolves to the Agreement in force when the
person acted, ADR 0006).

Note this is deliberately *not* §4.2's rule for timer **effects** from an
amendment ("apply only if the timer is still active … no retroactive timer
surgery"). That rule governs *mutating* a timer, where acting on a timer that has
since ended would rewrite history. Reading what a timer was doing at a past
moment mutates nothing, so the same caution does not apply — and the two clocks
sitting side by side is exactly the ADR 0002/0006 pattern, where the machine's
own bookkeeping and what-was-true-for-the-person deliberately differ.

## Near-misses: one new classification, and none for comparison

A comparison miss needs **no** taxonomy change. An unset key is already
`awaiting` (the pending-adjudication case, unchanged); a set-but-out-of-range
value is already the set-but-wrong near-miss the `isSurfaced` filter treats as
noise. Both behaviours are correct as they stand.

`timer_active` needs one. Like `subject_mismatch` it is structural — no ruling on
any key will ever resolve it — so it must never enter `awaiting`, or the queue
will promise a resolution that cannot arrive. Unlike `subject_mismatch` it is
transient rather than permanent, so it does not always deserve the trace.

It is surfaced **only when every other clause held** — when the ambient state was
the sole reason the rule stayed quiet. That is when the row is worth reading
("R26 didn't fire: no denial period was active") and it keeps every routine
orgasm outside a denial from filing a near-miss nobody asked for.

## Validation

`RuleValidationContext` already carries `timers: ReadonlySet<string>`, so
`timer_active` keys are checked against known timer definitions for free, in the
same shape as an effect's `timer` target.

A comparison clause is legal only on a `number` field. `severity > "major"` fails
at creation, next to the existing "condition references unknown key" errors,
rather than never matching for the rest of the couple's life.

## Considered options

- **Status quo — model the mode as a metadata key.** No engine change. Rejected:
  it asks the person reporting a lapse to also classify the state they were in,
  and every mistake is silent.
- **Gate the effect instead of the condition.** `route_when` is precedent for an
  effect-side gate. Rejected: the trace would record a rule that fired with an
  effect quietly dropped, and there is no near-miss row to explain the silence.
  The consent record has to be able to say why nothing happened.
- **A boolean "mode" setting the dom toggles.** Rejected: a timer already *is*
  the ambient-state primitive, with a span, an opener, a disposition, and a place
  in the trace. A parallel mode flag would duplicate all of it and drift.
- **`timer_active` with `match_on`.** The instance-scoped form ("is *this* task's
  countdown open"). Deferred rather than rejected — it is a strictly larger
  feature and the motivating case, `denial_period`, is a singleton.
- **Counter thresholds** (`demerits >= 10`). Rejected here: an escalation ladder
  is the scoring/rewards/consequences layer (#47) wearing a condition-language
  costume, and building it as rule conditions prejudges that decision.
- **Elapsed-time comparison** (`since_last_orgasm > 3d`). Rejected here: "nothing
  happened for five days" emits no event, so it needs the rule set evaluated on a
  schedule. That is a new execution mode, not a condition-language change. Note
  ADR 0003 declined a nearby request ("fire only if the dom hasn't come since X")
  and sent it to human adjudication with projected evidence; that ruling stands
  and this ADR does not disturb it.
- **Log lookback** ("has an X happened since Y"). Rejected: unbounded replay cost
  and the point at which a rule stops reading as a sentence.

## Consequences

- `ruleConditionSchema`, `RuleEventContext`, `matchRule`, `classifyMetadata`,
  `validateRule`, and `rule-describe` all change together. `rule-describe` must
  render both forms in the couple's voice — "while a denial period is running",
  "mood is 2 or less" — since the confirm sheet and the chain view share its
  phrasing.
- The rules-authoring UI gains two controls: a timer-activity clause and an
  operator beside numeric fields. Both are dom/switch-authored like every other
  rule edit (ADR 0002).
- The client's preview must be shipped the couple's **timers** alongside the
  rules. It already had them (the log view holds them for the composer's ref
  pickers), so this is a prop, not an endpoint. A preview built without them
  silently reverts to "no timer is running" and under-reports a ruling.
- `RuleEventContext.active_timers` is **required**, not optional. Omitting it
  would compile and then quietly under-fire every mode-scoped rule; the compiler
  is a better guard than a comment. `NO_ACTIVE_TIMERS` is the shared empty set
  for callers with no ambient state (a rules-screen description, a unit test).
- `timer_active` itself is **optional** on the condition — absent means
  unconstrained. Defaulting it to `{}` instead would force every existing rule
  literal in the codebase to declare an empty map that says nothing. Read it
  through `ambientClauses` so the three consumers agree on that reading.
- Two pack rules land, bumping the pack to version 10:
  - **R26 "Unpermitted orgasm during denial"** — `orgasm`, `subject_role: sub`,
    `permitted: false`, `timer_active: { denial_period: true }` → +2 demerits.
    It stacks on R12's flat +2 rather than replacing it, so the escalation is one
    readable rule instead of a rewrite of the base case, and R14 keeps closing
    the denial as `failed` independently.
  - **R27 "Check-in flags a low mood"** — `check_in`, `mood ≤ 2` → notify
    partner. Its bound is exactly the kind of thing one couple wants at 2 and
    another at 3; adopt-on-edit already handles that, and this is a good first
    test of a pack rule whose *number* is the thing couples will edit.
- Existing rules are untouched: an absent `timer_active` matches regardless of
  ambient state, and a bare metadata value is still an equality.
- **The line this ADR draws for the next extension**: a condition may test what
  the event carries, who it is about, and what was running when it happened. It
  may not count, measure elapsed time, or query the log. When that line next
  needs crossing, it wants a scheduled evaluator or the scoring layer — not
  another clause on the condition map.
