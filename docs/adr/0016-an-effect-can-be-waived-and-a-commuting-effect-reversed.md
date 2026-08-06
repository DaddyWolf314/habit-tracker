---
status: accepted
---

# An effect can be waived, and a commuting effect reversed

`reevaluate` is forward-only. It returns the rules that fire in `after` and did
not fire in `before`, and nothing is ever un-fired. #184 pinned the consequence:
amending a key that was **already set** leaves the prior ruling's effects applied,
so a `supersedes` correction and a dom override of a self-stated key are both
unsafe to expose. The queue only ever lists *pending* events, which is the sole
reason no shipped surface has hit it.

#184 deferred the fix to #47 and gave a specific reason for deferring rather than
building:

> Building partial reversal now would deliver it for counters and not for anchors
> or timers … a closed timer has no honest inverse. That asymmetry would be worse
> than the current honest limit.

The asymmetry is real and this ADR does not dissolve it. What it does is separate
two acts that #184 had to treat as one, and then decide that an asymmetry
*recorded in the ledger* is not the same thing as an asymmetry that is silent.

## Two different acts

**Waiving** is discretionary. The rule fired correctly, the fact it matched on is
true, and the dom is choosing mercy. The record should say a mercy happened.

**Correcting** is not discretionary. The ruling was wrong, so effects are attached
to a fact that is no longer true. The record is internally inconsistent, and a
rebuild reproduces the inconsistency deterministically rather than healing it —
which is the correct behaviour under ADR 0012 and is exactly why it cannot be
papered over at the projection layer.

They want different mechanics, and conflating them is what made the problem look
unsolvable.

## Waiving is a fifth amendment kind

`waiver` joins `adjudication`, `note_appended`, `retracted`, and `response`. An
amendment is "a post-hoc record against an event", which is what a waiver is; the
alternative — a direct counter adjustment — would file a relationship act under
the `+1` sugar and leave the trace saying "dom adjusted demerits −1" without ever
saying why.

One kind, two mechanics, chosen by whether the effect has landed yet.

### Waived before it lands: suppressed

On the confirm sheet the dom is previewing effects that do not exist yet — the
sheet re-runs the pure engine over the target with the ruling merged in and diffs
against what already fired. Unchecking one means it is **never applied**. A single
trace row records both halves of the fact: R12 proposed +2 demerits, and the dom
waived it.

The alternative was to let it fire and then compensate, which would have given
waiving and correcting one mechanism. It was declined because the counter's
history would carry a peak that never existed. The DO commits serially, so there
is no live flicker to see — but `rebuildCounters` is what makes the materialized
value *provably* a cache, and a value that momentarily read 12 is a value the
ledger has to explain forever, twice per waiver, for no gain.

### Waived after it lands: reversed

`R2: ritual_completed AND late=true → demerits +1` fires at append when the sub
self-reports being late. No ruling is involved, so there is no confirm sheet and
nothing to uncheck. A standalone `waiver` amendment names the fired effect and
reverses it under the rule below, or records that it could not be.

**The gate is the rule-authoring roles** (dom/switch, ADR 0002): whoever may write
a rule may overrule its output. Tracking the type's `adjudicated_by` instead was
declined because unconditional effects sit on types with no awaited key at all,
which would leave exactly the R2 case ungated.

## A correction always lands

The correction records the truth about the ruling whether or not any effect can be
undone. Refusing corrections that are not fully reversible was considered — it is
the safety-structural shape this repo usually prefers, an invariant the model
enforces rather than a warning a surface shows — and it was declined because of
what it forbids: the dom could not record that they got R12 wrong *at all*.

Blocking the record is the worst outcome available to a log whose stated purpose is
being an auditable relationship record. Fixing the projections is a separate
question with a separate answer, and it is allowed to answer "no".

## Reversible means the inverse still commutes

Not "counters are reversible". That rule is too coarse, and the case it misses
puts a lie on a screen the sub reads:

```
R12 fires            → demerits +2   (demerits: 12)
sub acknowledges     → reset          (demerits:  0)
dom corrects ruling  → reverse −2     (demerits: −2)
```

`applyCounterOp` has no floor, so that number lands. The punishment had already
been discharged, and the reversal subtracted it from nothing.

The precise condition is a property, not a list: **an effect is reversible exactly
when its inverse still commutes with everything that has happened since.** A
compensating delta commutes with other increments and decrements, so reversing
across them is exact regardless of how many intervened. It does not commute with a
reset, a scheduled rollover, or an acknowledgment.

That condition is checkable, and it is checkable against state the app already
keeps: the trace holds every counter move with `from` and `to`, so "has anything
non-commuting touched this counter since" is a query, not a new table.

Everything else is never reversible — a counter reset (its inverse would clobber
whatever accrued since), an anchor reset, a timer open or close, a notify. This is
not a new refusal: `couple-do.ts:2170` already declines retroactive timer surgery,
and a closed countdown has no honest inverse to offer.

### What an unreversed effect does instead

It files a trace row saying it could not be reversed and why — the shape a
**near-miss** already established. The engine records why a rule did not fire so
that pending state is legible; the same instinct says to record why an effect did
not un-fire.

This is #184's asymmetry, and it is now stated in the ledger rather than lurking in
the model. Correcting an unpermitted-orgasm ruling reverses the demerits, leaves
`since_last_orgasm` reset, leaves the denial countdown failed, and says so on the
chain view. The couple can see exactly what stayed and can talk about it, which is
the mechanism this app reaches for everywhere else it cannot compute an answer.

## Replay

Both mechanics are driven by amendments, and amendments are in the log. A
suppressed effect is suppressed on replay because the waiver is read at the same
point in the sequence; a reversal replays at its own position, and the
commutativity check runs against the trace the replay is itself rebuilding.
Live-equals-rebuild (ADR 0012) holds without a preserved-state exception, which is
the property that made suppression worth preferring over compensation.

Reversal changes counter values, which changes what a *later* `counter_value`
clause (ADR 0015) would have seen. Nothing re-fires. Forward-only stands as the
rule for events already evaluated — the past keeps the consequences it received —
and replay reproduces it exactly, because later events replayed against the reduced
value in the same order live did.

## Consequences

- `amendmentSchema` gains `waiver`; `amendment-validation.ts` gains its gate;
  `shared/amendments.ts` and the log view gain its rendering.
- The confirm sheet's effect list becomes checkboxes. `queue-panel.tsx:158`'s
  comment — "visibility only; no effect-waiving (a scoring-layer concern)" — is
  the thing this removes.
- `reevaluate` keeps its forward-only contract unchanged. Reversal is computed
  beside it from the superseded ruling's recorded effects, not by making
  re-evaluation bidirectional. Its doc comment gains the pointer here.
- The waiver amendment records **which** effects it suppressed or reversed, by rule
  id and effect index, because the trace row has to name what was waived and a
  rebuild has to reproduce the same choice.
- A waived effect still counts as the rule having *fired*. The near-miss list is
  for rules that did not match, and blurring the two would make the ledger unable
  to distinguish "this never applied to you" from "this applied and I let it go".
- #184's documentation task is superseded by this. Its regression test — amending
  an already-set key leaves prior effects applied — inverts: the reversible case
  now reverses, and the test that stays is the *unreversible* one.
- No reversal is offered for effects fired by a rule version that has since been
  edited. The superseded ruling's effects are read from the trace, which records
  what actually fired, rather than re-derived from a definition that may have
  changed underneath (ADR 0002).
