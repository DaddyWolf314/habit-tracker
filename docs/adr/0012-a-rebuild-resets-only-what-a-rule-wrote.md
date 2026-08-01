---
status: accepted
---

# A rebuild resets only what a rule wrote

`rebuildCounters` is the proof of a claim the whole projection layer rests on:
that every materialized value is *only* a cache, reconstructible from the
immutable log (handoff §4.4), and that every change has a recorded cause
(§4.6). It makes that proof by clearing the derived state and replaying the log
through the same apply-path the live append uses, so the rebuilt values match
live application by construction.

That argument has one hole, and the projection layer has now fallen into it five
times. Replay reconstructs what the log records. Some derived state is *not*
recorded by any event — a sweep firing, a dom's live-control command, a calendar
boundary — and for that state "clear it and replay" does not reconstruct it, it
destroys it. Every defect below is a different answer to the question "which
state is that?", and every one of them was wrong.

This ADR fixes the answer.

## The invariant

> **Reset exactly what a rule wrote. Preserve everything a rule could not have
> written. Re-derive off-log state only when it is a pure function of durable
> state, never when it records a moment.**

Applied to the projections that exist today:

| Projection | Treatment | Why |
| --- | --- | --- |
| counters, anchors, trace | reset, re-derived | written by rule effects, so replay reproduces them |
| timer closes `completed` / `failed` | reset, re-derived | the dispositions a `close_timer` effect may write |
| timer closes `expired` / `auto_closed` | preserved | written by a sweep, stamped with the moment it *noticed* |
| timer close `canceled` | preserved | a dom live-control command; no event records it |
| countdown `deadline_at`, `paused_at` | preserved | moved by the dom's pause and extend, off-log |
| period resets (daily / weekly) | re-derived between replay steps | off-log, but a pure function of the calendar |
| streak folds | re-derived at each boundary | *was* the one exception — closed by ADR 0013 |

The second column is the whole ADR. The first two rows are the easy case; the
rest are where it went wrong.

### Deriving the reset list, rather than restating it

The reset keys off `TIMER_CLOSE_STATUSES`, exported from `shared/rules.ts`
beside the `close_timer` effect's own status enum — not off a literal in
`rebuildCounters`. The two readings of that enum ("what a rule may write" and
"what a replay can re-derive") are the same set by construction, and tying them
together in code means adding a verb-writable disposition cannot silently leave
the rebuild resetting a stale set. This is a projection with a five-defect
history in exactly that seam; a comment would not have been enough.

## The five defects

Each is rebuild-only, silent, and in the scoring direction — because a rebuild
is the only thing that re-derives a couple's demerits from scratch, and because
nothing surfaces a divergence between the cache and the replay.

1. **The ambient predicate read `status`, not the span** (#163). `rebuildCounters`
   resets rule-closed countdowns to running before replaying, so a `status IS NULL`
   test saw every denial as active from the first replayed event, and R26
   escalated orgasms that predated the denial entirely. Fixed by reading the
   durable span (ADR 0011).
2. **The reset was blanket** (#163). Clearing `closed_at` for *every* countdown
   stranded the `expired` and `canceled` ones open for good — replay re-closes
   only what an event closed. Fixed by scoping the reset to the rule-written
   dispositions.
3. **Replay duplicated every countdown** (#165). ADR 0004 made a countdown's
   *open* event-derived (R22/R23), but the rebuild still treated countdowns as
   durable dom state. So it preserved the row *and* replay opened a second one —
   running, unbounded, accumulating one more on every rebuild. Fixed by having a
   replayed open re-adopt the row its own event created.
4. **A close matched a timer that had not opened yet** (#166). `closeTimer`
   matched on `status IS NULL` alone. Mid-replay every rule-closed countdown
   reads as open from the start of the log, so the earliest unpermitted orgasm
   closed a denial that began hours later — stamping a `closed_at` earlier than
   its own `opened_at`, a span that then read as shut for the rest of the replay.
   Fixed by bounding the match to the closing event's own moment, the same span
   test the `timer_active` condition uses.
5. **A rebuild credited withheld service minutes** (#167). Stopwatches were
   deleted wholesale before replay, on the theory that an over-max auto-close
   would be "re-derived by the next sweep". It was not. Worse than the inverted
   `{ session_stopwatch: false }` clause ADR 0011 documented: a session the sweep
   had `auto_closed` — flagged for review, deliberately *not* auto-credited —
   came back `completed` on replay, routing its full duration into
   `service_minutes_week`. Fixed by preserving stopwatches exactly as countdowns
   are preserved.

Defects 3 and 4 are worth reading together. #165's duplicate row was *masking*
#166: the phantom instance was open and unbounded, so R26 still fired off it and
the counter landed on the right total for the wrong reason. Fixing #165 alone
turned a silent compensation into a visible under-count. Neither was safe to fix
without the other, and no amount of reading found the second — the harness did,
within an hour of existing (#164).

## Why a sweep's close is preserved rather than re-derived

The obvious repair for defect 5 — and the one #164 proposed — is to run the
sweeps at each replayed event's timestamp rather than at `now`. It re-derives
*whether* a timer closed. It does not re-derive *when*, and that is the half
that matters.

Both sweeps stamp the moment they ran, not the boundary they crossed:

- `sweepOverMaxStopwatches` writes `closed_at = now` on `auto_closed`;
- `sweepExpiredCountdowns` writes `closed_at = now` on `expired`.

Live, that moment is whenever the alarm fired or a read happened to run. On
replay it would become the timestamp of whichever event came next. Same
disposition, different `closed_at` — and `closed_at` is precisely what the
ambient predicate reads as the end of the span, so the divergence would be the
scoring kind.

### And why the closes are not moved to the boundary either

The alternative is to make a swept close land on the boundary it crossed — an
over-max stopwatch at `opened_at + max`, an expired countdown at `deadline_at` —
making both pure functions of durable state, and replay-reproducible.

**Rejected**, because it would introduce a live/rebuild divergence rather than
remove one. Consider an event logged between a deadline passing and the sweep
noticing:

```
deadline ──────── X ──────── sweep
                  ↑ event logged here
live      the row is still open      → the denial reads as running   → R26 fires
rebuilt   closed_at = deadline       → the denial reads as shut at X  → R26 silent
```

Today's `closed_at = the moment we noticed` makes both readings agree, which is
what `activeTimerDefinitionsAt` already argues: an expiry ends the span honestly
without the predicate having to reason about deadlines, which pause and extend
rewrite in place. Moving the stamp trades a rebuild gap for a rebuild divergence
of exactly the class this ADR exists to end. The alarm arming at the deadline
keeps the window small in practice, but "small" is not the property wanted here.

A swept close therefore records *when the system noticed*, which is a true thing
about a system that can only notice on waking — and being unreproducible is what
makes preserving it mandatory rather than optional.

## The exception that was: streak folds

**Closed by ADR 0013 — this section records why it existed.**

Streaks were preserved despite being the one projection replay could
reconstruct. A fold is `target met? +1 : 0` over the target counter's
end-of-period value, and both the value and the boundaries are derivable —
`replayScheduledResets` already computed exactly those boundaries.

They were preserved because the *target* the fold compares against lives on the
counter **definition**, and counter definitions were not effective-dated the way
rules are (ADR 0002). Re-deriving a streak would have scored every past period
against today's `daily_target` — retroactive re-scoring, which is the thing
effective dating exists to prevent, and which this ADR would otherwise have
reintroduced through the back door.

ADR 0013 gives counter definitions that history, so the fold now replays against
the policy in force for each boundary and the exception is gone. The invariant
above holds without a carve-out.

## Consequences

- `rebuildCounters` resets by disposition, not by timer kind. One statement
  covers stopwatches and countdowns, because the split that matters is
  rule-written versus not, and kind was never the right axis.
- `openTimer` re-adopts an instance its own event already opened, keeping the
  row's id, its extended deadline and any pause. On the live path the lookup can
  never match — the event was inserted moments ago and this is the rule's first
  fire on it — so the shared apply-path stays genuinely shared.
- `openTimerRows` takes an optional `at`. `closeTimer` passes the closing event's
  `occurred_at`; the amendment guard does not, keeping "is there a live instance
  *now*" for a ruling, which is the question handoff §4.2 asks.
- A close backdated before its open is an orphan with a trace note, live as well
  as on replay, since `occurred_at` is caller-settable. It used to close the
  timer with the negative span clamped to zero — a closed countdown claiming it
  took no time. Nothing in the client sets `occurred_at` yet; when a backdating
  writer ships, the entry-time warning belongs in that form, where it can be a
  field validation rather than a refusal to record what the couple said happened.
- ADR 0011's "stopwatches remain a known gap" is closed, and its proposed fix is
  rejected here on the record.
- The invariant is testable and now tested: `src/worker/do/couple-do.test.ts`
  drives a real `CoupleDO` over the SQLite engine it embeds, and the shape most
  of those tests take — build a log, snapshot the live cache, rebuild, assert the
  two agree — is this ADR stated as an assertion.
