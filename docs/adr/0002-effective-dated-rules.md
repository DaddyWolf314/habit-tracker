# Rules are user-editable, effective-dated, and forward-only

## Status

accepted

## Context

Rules (the `when type = X [AND metadata equality] → effects` engine primitive)
ship as a default pack, R1–R20, seeded per couple. Until now they were effectively
read-only: a create path existed with no UI, no reserved-namespace escape, and no
way to edit, version, or meaningfully remove a rule. We want couples to **view,
edit, and create** rules from the app.

Two properties of the system make "edit a rule" non-trivial:

- The event log is the couple's **consent record / accountability spine** — an
  honest record of what actually happened. Rules fire at append time and their
  effects are recorded in the trace; `reevaluate` on adjudication already "only ever
  adds effects, never un-fires."
- `rebuildCounters` re-derives all projections by replaying the log under the
  **current** rule set — rules were never effective-dated. The code flags this: after
  a rule changes, a rebuild silently re-derives history under today's rules, "proper
  per-event rule versioning a later phase."

A naive editable-rules feature — mutate a rule in place, keep rebuilding under
current rules — would let a dom retroactively rewrite the sub's past
accountability (edit "late ritual → +1 demerit" to +2 and every past late ritual
re-scores on the next rebuild). That guts the consent record.

## Decision

Rules become user-editable under an append-only, effective-dated model:

- A **stable rule id** carries one or more **rule versions**, each with an
  `effective_from`. Editing adds a version; prior versions are retained read-only.
  Replay picks the version in force at each event's **log-time** — including for a
  late adjudication of a pre-existing event, which fires the version in force when
  that event was logged, not the current one.
- Rule changes are **forward-only**. Already-logged events keep the consequences
  they received; `rebuildCounters` becomes version-aware so a rebuild *reproduces*
  history rather than rewriting it.
- **Authoring (create/edit/enable/disable/purge) is gated to `role ∈ {dom, switch}`**;
  viewing is open to both members. Every change writes an `audit_log` row and
  surfaces an in-app notice to the partner — transparency standing in for a
  mutual-consent handshake, so dom-only authoring stays consensual for the sub who
  is bound by rules they cannot author.
- Default-pack rules are editable via **adopt-on-edit**: editing an `R#` rule freezes
  it against future pack overwrites (bumps still add new rules and may flag upstream
  changes). The `R#`-namespace guard relaxes to permit *editing* pack rules; minting
  brand-new `R#` ids stays reserved to the pack.
- "Delete" collapses to **disable** (effective-dated; versions retained for replay).
  A true hard-delete is allowed only for a custom rule that has never fired.
- Rule changes are **not** events — they record only to `audit_log`, preserving the
  invariant that rules never write to the event log.

## Considered options

- **Retroactive edits (rebuild under current rules).** Simplest: no versioning, one
  "current rules" replay path. Rejected — a rule edit rewrites the sub's past
  accountability, gutting the consent record.
- **Forward-only without effective-dating.** Never rewrite the trace day-to-day, but
  leave `rebuildCounters` replaying under current rules (the existing documented
  divergence). Rejected — the honest-history guarantee would hold only until the next
  rebuild, which would then retro-apply every edit.
- **Mutual consent on every change.** Leans on the existing `consent_history` model.
  Rejected as the default — too much friction per edit; the audit-log + partner-notice
  path gives transparency without gating each change.

## Consequences

- The deferred **per-event rule versioning** work is now in scope and load-bearing:
  the rules store, `rebuildCounters`, and the trace's rule references must all be
  version-aware.
- Old rule versions are never deleted (they are needed to replay old events), so the
  rules store grows with edit history — the intended cost of a log that stays
  honestly rebuildable.
- "Effective-dating keys off log-time" must be applied uniformly, including the
  `reevaluate`-on-adjudication path, or a late ruling could smuggle a newer rule
  version onto an older event.
