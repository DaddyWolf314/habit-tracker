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
- **Stopwatch / Countdown** — the two timer flavors. A stopwatch *accumulates*
  (paired `session_started`/`session_ended` sharing a `session_id`, duration
  derived on close); a countdown is a *deadline* (created at assignment, terminal
  `completed`/`failed`/`expired`, dom may pause and extend). _Avoid_: "session" for
  the stopwatch itself — a session is the pair of events that opens and closes one.
- **Target counter** — a counter carrying a daily/weekly target. A **streak** is a
  property of one: a consecutive-target-met count the DO alarm evaluates at
  rollover — never a rule. _Avoid_: modeling a streak as a rule.

## Relationship & roles (handoff §2)

- **Couple** — the two paired members and all their shared data; the unit of
  isolation (one Durable Object per couple). _Avoid_: "account", "tenant",
  "workspace".
- **Member** — one partner's record inside a couple (identity, devices, role).
  _Avoid_: "user" (routing-layer concept) and "partner" when you mean the record.
- **Role** — one of `dom | sub | switch`: the three permission buckets that rules
  and schemas gate on (`set_permission`, `adjudicated_by`, `log_permission`).
  Custom labels are display-only. _Avoid_: inventing mechanical roles beyond these.
- **Dynamic** — the *activated* D/s relationship. Inactive until both members
  confirm roles (**mutual confirmation**); frozen by pause-everything, ended by
  dissolve. _Avoid_: "relationship" when you specifically mean the live, activated
  state.
- **Pairing** — the flow that binds a second member into the couple and then
  **permanently closes** to further invitations. _Avoid_: "signup"; "onboarding"
  (the UI surface, not the binding).
- **Dissolve** — either member's unilateral, unblockable termination: freeze →
  export offer → delete. _Avoid_: "cancel", "unpair", "leave".
- **Pause-everything** — either partner's one-tap freeze of all tracking (suspends
  alarms and countdowns without logging failures). The *safeword* philosophy
  expressed in the mechanics. _Avoid_: "safeword" as the feature/identifier name —
  it names the philosophy, not the mechanism.
- **Consent history** — the append-only record of agreement entries (role
  confirmations and the like); the first entry is the mutual role confirmation.
  Distinct from the log-as-consent-record framing (see Trace).

## Event schema & adjudication (handoff §5, §8)

- **Event type** — a per-couple typed schema for an event (label, valence,
  permissions, metadata fields, `awaiting`). Custom types are identical in shape to
  the built-ins. _Avoid_: "template" (a template is the *shipped default*, not the
  schema).
- **Starter Seven** — the seven default event types shipped in the template pack;
  every default projection must derive from only these.
- **Metadata** — an event's typed key/values (`boolean | enum | number | ref`
  only; freeform prose lives in `note`). _Avoid_: "fields", "attributes", "props".
- **Valence** — `positive | negative | neutral` on a type or counter; drives
  display and the deferred scoring layer. Overridable per rule effect.
- **Composite state** — an event's current metadata: original overlaid by
  amendments in timestamp order, latest non-superseded winning per key. Derived,
  never stored (`composite_metadata` in code). _Avoid_: "merged" / "effective"
  metadata as competing names.
- **Pending** — an event's derived status while any `awaiting` key is still unset
  in composite state. The single mechanism behind the adjudication queue; never
  stored. _Avoid_: "unresolved", "open", "in queue".
- **Awaiting** — the event-type schema's list of metadata keys that gate pending
  status. _Avoid_: "required" (a separate per-field flag: an awaited key can be
  optional at logging time yet still gate the queue).
- **Adjudication** — the amendment by which a role rules on an awaited key after
  the fact (per `adjudicated_by`). One active ruling per key; corrections
  supersede. **Ruling** is the UX-facing word for the same act. _Avoid_: "grade",
  "approve/reject".
- **Adjudication queue** — the lens over the log showing events pending a given
  role's ruling. A view, **not a holding pen** — pending events are already in the
  log and have already fired their unconditional rules. _Avoid_: "inbox",
  "approval queue".
- **Notification** — the single content-free unread *count* a member polls, shown
  as a discretion-safe badge ("You have N new items"; handoff §3.5, #42): pending-
  adjudication events plus a targeted recovery notice, composed in one place
  (`shared/notifications.ts`). A number only, never any relationship content.
  _Avoid_: "inbox" (a count, not a container — and the banned adjudication-queue
  synonym).

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
