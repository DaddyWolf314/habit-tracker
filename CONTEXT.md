# Context — habit-tracker domain glossary

The ubiquitous language for a couples' habit & protocol tracker (see
`docs/handoff/bootstrap.md` for the full spec). Use these terms exactly in code,
issues, and design notes; the "avoid" notes call out synonyms that have drifted
in and should not.

## Core primitives (handoff §4)

- **Event** — an append-only, human-authored record; the source of truth. Never
  mutated or deleted. Rules never create events. _Avoid_: "log entry" when you
  mean the typed record.
- **Amendment** — a post-hoc record against an event: an `adjudication` (ruling),
  a `note_appended`, or a `retracted`. Composite state is the original metadata
  overlaid by amendments in timestamp order — derived, never stored.
- **Rule** — `when type = X [AND metadata equality] → effects`. Routes values; it
  never computes them. The condition language is deliberately dumb (equality only).
- **Effect** — one op a fired rule routes: counter increment/decrement/reset,
  anchor reset, timer open/close, notify.
- **Counter / Timer / Anchor** — the three **projection** flavors: a materialized
  tally, a stopwatch/countdown, and an elapsed-since timestamp. Each is a **cache**
  rebuildable by replaying the log.
- **Projection** — any derived, materialized view of the log (a counter, timer, or
  anchor). _Avoid_: "aggregate" (DDD-loaded), "view model".

## Trace (handoff §4.6)

The transparency spine: every projection change records **what caused it**, so the
consent-record view and the debugging view are the same screen. Lives in the deep
`shared/trace.ts` module (the **Trace ledger**).

- **Trace** — the causal record. One **trace row** per projection change (and per
  near-miss). Rebuildable for event-driven rows; off-log rows (system jobs, dom
  commands) are not re-derived by a rebuild.
- **Cause** — *why* a row exists, as a typed `TraceCause`: `rule` (a rule fired on
  an event), `direct` (direct-manipulation sugar), `amendment` (an effect a ruling
  unlocked), `system_job` (a scheduled rollover/reset or timer sweep), or
  `dom_command` (a dom-issued countdown assign/pause/resume/extend). _Avoid_:
  reading `caused_by_rule` as a string sentinel — the cause is column-derived.
- **Detail** — *what* changed, as a typed `TraceDetail` discriminated union (one
  `kind` per change: counter, anchor, timer_open/close/skipped, notify, near_miss,
  auto_close, expire, streak_rollover, scheduled_reset, timer_command). Stored as
  a JSON string in the `trace.detail` column; typed at the read model.
- **Near-miss** — a rule that matched on type but did not fire because a condition
  key was unset or wrong. Recorded so pending-adjudication state is legible
  ("R12 didn't fire: permitted not set"). Surfaced only when waiting on a key the
  event type is `awaiting`.

The module owns the taxonomy end to end: pure **builders** the write side calls
(one `writeTrace` sink in `CoupleDO` does the single INSERT), the `encodeDetail`
/`decodeTraceRow` codec, and the `describeTraceRow`/`summarizeEffectOp` decoders
the UI renders through. Effect **phrasing** is shared so "what will fire" (the
dom's confirm sheet) and "what fired" (the chain view) read identically.
