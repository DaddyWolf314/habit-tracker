---
status: accepted
---

# Counter definitions are effective-dated

ADR 0012 established that a rebuild resets exactly what a rule wrote and
preserves everything a rule could not have written. It recorded one deliberate
exception, and this ADR removes it.

Streak counters were preserved across a rebuild despite being the one projection
replay *could* reconstruct. A fold is `target met? +1 : 0` over the target
counter's end-of-period value; the value is derivable from the log and the
boundaries are derivable from the calendar. What was not derivable was the
**target** — it lives on the counter definition, and a counter definition was a
single mutable row with no history. Re-deriving a streak would therefore have
scored every past period against whatever the target says today, which is the
retroactive re-scoring ADR 0002 exists to prevent for rules.

So: give counter definitions the same effective-dated history rules and
Agreements already have, and then let streaks replay like every other
projection.

## The shape, and the third instance of it

`counter_versions` is the third table of the form the app already uses twice — a
stable identity row carrying append-only versions, each stamped with the moment
it takes force:

| | identity | versions | resolves at |
| --- | --- | --- | --- |
| rules (ADR 0002) | `rules` | `rule_versions` | an event's **log-time** |
| Agreements (ADR 0006) | `agreements` | `agreement_versions` | an event's **`occurred_at`** |
| counters (this ADR) | `counters` | `counter_versions` | a **rollover boundary** |

The mechanism is already shared — `versionInForceAt` in `effective-dating.ts`
picks the version, and its doc comment already says the interesting part is which
clock each caller resolves against. Counters add a third clock, and it is not a
variation on the other two: a counter's policy is not read by an event at all. It
is read by a *system job*, so the moment that governs is the period being folded.

Shaped after v8 in one further respect: `counters.definition` is retained as a
mirror of the latest version, kept in step because `writeCounterDefinition` is
the single write path for both. Only the reads that resolve a moment — the
rollover fold and the rebuild replay — go through the versions; the ~16 other
reads keep using the identity row and did not have to change.

### Everything but the `id` versions

Including `name`, for the reason ADR 0009 gave for rule names, and for the same
sharpness: a counter's history is *displayed* — its name renders against its own
past trace rows — so a name on the identity row would retroactively rewrite what
those rows say the counter was called.

Nothing is held back on the identity row the way an Agreement's `kind` is (ADR
0006) or its `subject` is (ADR 0010). Those two are withheld because versioning
them would open an escalation path: re-kinding is how you would otherwise author
in the other role's category. A counter has no such hazard — `updateCounter` is
already ungated, any member of a live couple may shape a shared counter, so
versioning `modify_permission` grants nobody anything they did not have.

## Replaying rollovers: every boundary, not just the first

Re-deriving streaks forced a second change, and it is the larger one.

`replayScheduledResets` collapsed multiple boundaries of one period in a single
gap into one pass, with the reasoning stated in its own doc comment: *"a gap
spans no events, so nothing accrues between them."* That is sound for a reset,
which is idempotent — zeroing twice is zeroing once.

It is false for a streak fold, which is not idempotent. A met day followed by
three idle ones folds `+1, 0, 0, 0` and ends at zero. Collapsed into a single
pass it folds `+1` and stops, leaving a streak alive across three days the couple
did nothing. The replay therefore walks **every** boundary in the gap, daily
before weekly where they coincide (Monday 00:00 UTC is both), matching the order
`scheduleRows`' `ORDER BY next_fire_at, id` gives the live alarm.

Each boundary runs through the same `runRollover` the alarm calls, now taking the
policies to fold against. Live it reads the mirror; a replay passes the versions
in force at that boundary. Same code, both paths — which is the property ADR 0012
rests on, and which a separate replay-only fold would have quietly given up.

Two consequences fall out of routing replay through `runRollover`:

- The rebuilt trace now carries the `streak_rollover` and `scheduled_reset` rows
  the alarm writes. The old replay zeroed period counters with a bare `UPDATE`
  and recorded nothing, so a rebuild silently dropped part of the transparency
  ledger it is supposed to reconstruct.
- No projection is exempt from the rebuild any more. The initial zeroing covers
  every counter, streaks included, and the `NOT IN (…)` carve-out is gone.

### Where this stops reproducing live, deliberately

`catchUpFireAt` means a genuinely *missed* alarm — the platform failing to run
for days, not a dormant DO, whose alarms still fire on schedule — collapses into
a single catch-up fire, folding one period where several elapsed. A replay walks
all of them.

That is a divergence, and it is the intended direction: the couple did not do the
ritual on those days, and the streak should not have survived them. The rebuild
repairs what the missed alarm lost rather than reproducing it. It is recorded
here because ADR 0012 claims a rebuild reproduces live by construction, and this
is the one place that claim is deliberately not met.

## Backfill

One version per counter, effective from 0, carrying today's definition — the v8
rule backfill exactly. It cannot recover targets that changed before the
migration, because nothing recorded them, so the first rebuild after this lands
scores pre-migration history against today's policy: the very thing this ADR
prevents, once, for history that predates it.

Accepted rather than mitigated. The set of counters affected is empty — no couple
has edited one, and an unedited pack counter re-derives identically either way —
and the alternatives (freezing the pre-versioning streak as a floor, or splitting
the rebuild into two eras) would add a second preserved-state concept to a
mechanism this session spent five defects simplifying. Build the mechanism, skip
the archaeology (ADR 0010).

## Consequences

- `rebuildCounters` no longer carves streaks out of its zeroing, and ADR 0012's
  exception table entry for them is closed.
- `runRollover` takes an optional `policies` argument. Omitted, it reads the
  mirror, which is what the alarm wants; a replay passes
  `countersEffectiveAt(versioned, boundary)`.
- A counter created mid-history folds nothing for boundaries before its first
  version, because `countersEffectiveAt` omits it — "did not exist" and "existed
  and was unmet" are different, and only the second should break a streak.
- `deleteCounter` deletes the versions with the identity. A counter id may be
  reused (`uniqueCounterId` only avoids live collisions), and a stale history
  would otherwise attach a new counter to a deleted one's policy.
- A pack bump appends a version only for counters whose policy actually changed
  (`sameCounterPolicy`). Otherwise every bump would write a version per counter
  recording that nothing happened.
- The rollover replay costs one query for the version history plus an in-memory
  resolution per boundary, so a couple dormant for a year is one query and 365
  folds rather than 365 queries.
