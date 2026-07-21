# Journal entries carry a three-level visibility, gated to journaling event types

## Status

accepted

## Context

The couple's Durable Object holds **shared** data: "role-asymmetric views
derived from the same data." If it is in the log, both partners see it. That
invariant is load-bearing for the transparency/consent spine — the consent-record
view and the debugging view are the same screen.

Journaling breaks the comfort of that assumption. Self-directed journaling is only
genuinely the sub's if they can write something the dom will not read; and a dom
sometimes wants to *require the act* without wanting the words. So the prose in a
journal entry needs a privacy dial that the rest of the log deliberately does not
have.

## Decision

Every **journal entry** carries an author-chosen **visibility**, one of three
levels — the author always chooses explicitly, there is no silent default:

- **shared** — the partner sees the entry and its prose.
- **sealed** — the partner sees *that* an entry exists (it can close an assignment
  and drive a shared projection) but never the prose.
- **secret** — the partner cannot tell the entry exists at all; consequently a
  secret entry is **inert** (fires no rules, touches no shared projection or trace
  row), or its existence would leak.

Visibility is **gated to journaling-capable event types** via an explicit flag on
the event-type schema. Accountability types (`infraction`, `orgasm`,
`task_completed`, …) and the plain `note` type are *not* journaling-capable and are
always `shared`. Any visibility other than `shared` is legal only on a
journaling-capable type.

An assigned prompt may set a **floor** (`sealed` or `shared`): only an answer at or
above the floor satisfies the assignment. A sub may still answer below the floor
(even `secret`) — an inviolable right to journal privately — but that entry does
not discharge the assignment and is never revealed.

## Considered alternatives

- **All entries shared** (no privacy dial). Rejected: "self-directed journaling"
  with no possibility of privacy is barely self-directed.
- **Two levels (shared / private-hidden).** Rejected: it cannot express "I required
  you logged it, I don't need the words" (sealed) *and* "you can't tell this
  exists" (secret) at once — the dom needs the former, the sub needs the latter.
- **Making journaling-ness inferred** (any noted event is hideable). Rejected: it
  would make accountability events hideable, gutting the consent-record spine.

## Consequences

- This is the **first real access-control rule inside the couple DO**. The read
  model must filter prose (and matching metadata) by visibility and author; the
  pending/queue derivation stays visibility-blind because the dom *response* is a
  gift, not a tracked debt, so nothing pending ever references a hidden entry.
- **Export** gains a branch: a sealed/secret entry exports only to its author.
- The three levels form a deliberate **privacy/credit gradient** — `shared` = words
  + credit, `sealed` = credit without words, `secret` = fully private but no shared
  credit. Journaling only in secret therefore reads as a broken journaling streak.
  This is intended: it is what makes `sealed` a meaningful middle level rather than
  a synonym for `secret`.
