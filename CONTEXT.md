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
  never computes them (equality-only condition language). A stable rule id carries
  one or more effective-dated **rule versions**; authoring is dom/switch-only.
  _Avoid_: conflating with the **Protocol** an `infraction` cites.
- **Effect** — one op a fired rule routes: counter increment/decrement/reset,
  anchor reset, timer open/close, notify.
- **Rule version** — an effective-dated revision of a rule's condition and effects.
  Rules are append-only-versioned: editing adds a version (with an `effective_from`),
  never rewriting the prior, so replay picks the version in force at an event's
  **log-time** (when it fired). _Avoid_: "edit" as if a rule mutates in place.
- **Effective-dating** — a rule version governs only events logged while it was in
  force. Rule changes are **forward-only**: already-logged events keep the
  consequences they received, and a rebuild re-derives each event under the version
  current at *its* log-time — reproducing history, not rewriting it. _Avoid_:
  "retroactive" rule changes.
- **Adopted rule** — a default-pack rule (`R#`) a couple has edited. Adoption freezes
  it against upstream: a pack version bump no longer overwrites its definition (only
  surfaces an upstream-changed notice), while un-adopted pack rules still track the
  pack. _Avoid_: "forked", "overridden".
- **Protocol** — a couple's behavioral agreement the sub is held to and can break,
  referenced by an `infraction`'s `rule_ref`. A human agreement (unstructured today),
  *not* an engine **Rule** (condition→effect automation); the two share the word
  "rule" and must not be conflated. _Avoid_: "rule" for a Protocol.
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
- **Subject** — who an event is *about*, distinct from **actor** (who logged it).
  An envelope field beside `actor`/`occurred_at`, not metadata: universal,
  fixed at logging, never amended. Either member may be the subject of any
  loggable type — authorship and aboutness are independent axes (the sub can
  log the dom's orgasm). _Avoid_: "target", "about whom" phrasings that drift;
  conflating subject with actor.
- **Subject-role qualifier** — a condition or schema clause that matches the
  *role* of an event's subject (`subject_role = sub`), resolved against the
  couple's member roles at evaluation time. The pack-portable way to write
  subject-sensitive rules and `awaiting` entries; member-id matching is never
  used in shipped definitions. In a switch/switch couple a `dom`/`sub`
  qualifier matches nothing — such rules go dormant by design. Naming
  convention: an *unqualified* projection name (`orgasms_lifetime`,
  `since_last_orgasm`) means the **sub's**; dom-side projections carry an
  explicit `dom_` marker (`since_dom_last_orgasm`).
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

## Journaling

Reflective prose (and structured self-report) captured as events. Not a new
primitive — it is a *category of event types* plus a question/answer pairing.

- **Journal entry** — a sub-authored event carrying one prose reflection in
  `note`. The unit is **one entry per prose question** (an answer is
  independently amendable, retractable, respondable). _Avoid_: "diary entry";
  "journal" for a single entry.
- **Journal prompt** — a dom-authored event that *poses* a question (prose in
  `note`; a `prompt_id` in metadata). A journal entry answering it carries the
  same `prompt_id` — a **question/answer pair linked by a shared ref**, the same
  shape as the `session_started`/`session_ended` pairing. _Avoid_: "assignment"
  as the noun (the countdown deadline is the assignment mechanism, not this).
- **Self-directed vs. assigned** — self-directed journaling is a journal entry
  with *no* preceding prompt; assigned journaling is a journal prompt the sub
  answers. Both produce the same journal-entry events. Authoring split:
  **assigning a prompt to your partner is dom-side** (the control act); **creating
  a journaling-capable event type you self-log is either member** (structured
  self-report is benign self-knowledge); **logging a self-directed entry is always
  the journaling member's**.
- **One prompt = one question = one deadline.** A multi-question assignment is
  several independent prompts, each closed by its own answering entry via a simple
  `prompt_id` match (no completeness logic). Prompts assigned together may share a
  display-only **batch tag** for grouping in the UI; the model treats them
  independently. A **mood** reading is a free-standing `check_in`, never bound to a
  `prompt_id` (it is a per-day/state signal, not an answer to a prompt).
- **Structured response** — a question answered by a *typed* value rather than
  prose is just a **metadata field** on a (custom) event type — the `check_in`
  shape (`mood` number, `flag` enum) generalized. Prose answers get their own
  entry; typed answers bundle onto one event. Typed answer schemas live only on
  event types (no separate "prompt" definition entity).
- **Journaling capability** — an explicit flag on an *event type* marking it as a
  journaling type: only such types carry the visibility axis (may be `sealed`/
  `secret`) and may be the answer paired to a prompt. Accountability types
  (`infraction`, `orgasm`, `task_completed`, …) and the plain `note` type are
  **not** journaling-capable and are always `shared` — a secret infraction would
  gut the consent-record spine. Custom structured questionnaires opt in by setting
  the flag. Rule: any visibility other than `shared` is legal only on a
  journaling-capable type.
- The countdown **deadline** on an assigned prompt is opened by a **rule** firing
  on the journal-prompt event (reusing the task→countdown wiring); the answering
  entry closes it by ref match.
- **Recurring prompt** — a scheduled job (a `schedule` row, like a ritual reset)
  whose payload re-emits a fresh `journal_prompt` event each period. The recurring
  config lives in the **schedule payload**, not a new definition entity (faithful
  to "no prompt entity"). Each firing is **independent**: a new night's prompt
  stacks alongside any still-unanswered prior one; rollover never auto-expires or
  replaces yesterday's prompt.
- **Visibility** — an author-chosen property of every journal entry, one of three
  levels (the author *always* chooses explicitly; there is no silent default):
  - **Shared** — the partner sees the entry and its `note` prose.
  - **Sealed** — the partner sees *that* an entry exists (it can close an
    assignment and drive a projection) but never the prose. The "I require you
    logged it, I don't need the words" level.
  - **Secret** — the partner cannot tell the entry exists at all. Consequence: a
    secret entry must be **inert** — it fires no rules and touches no shared
    projection or trace row, or its existence would leak. _Avoid_: "private" as a
    level name (it's the whole three-level axis, not one value).
  Visibility governs the **prose**; typed metadata redaction follows the same
  level. This is the first real access-control rule inside the couple DO and adds
  an **export** branch (a sealed/secret entry exports only to its author).
  The three levels form a **privacy/credit gradient**: `shared` = words + credit,
  `sealed` = credit without the words (drives shared projections), `secret` =
  fully private but earns no shared credit (inert). Journaling-only-in-secret
  therefore reads as a broken journaling streak — intended, not a wart.
- **Visibility floor** — a required *minimum* visibility (`sealed` or `shared`) a
  journal prompt sets on its answer. Only an entry at or above the floor
  **satisfies** the assignment (closes the countdown). A sub may still answer
  below the floor (even `secret`) — that is an inviolable right to journal
  privately — but such an entry does not discharge the assignment, which then
  expires unmet, and the dom is never told a below-floor entry exists.
  Self-directed prompts have no floor. `secret` is never a floor (that is just
  self-directed).
- **Response** — a new amendment kind: the partner's (in practice the dom's)
  post-hoc prose *reaction* to a journal entry. A **gift, not a debt** — never
  tracked as pending/owed, never queued. Allowed on `shared` entries (reacting to
  content) and `sealed` entries (acknowledging the act without the words), never
  on `secret` ones. Fires no rules, does not touch composite metadata, and is
  inherently visible to the entry's author. _Avoid_: overloading `note_appended`
  (that is the author's own added context) for this.

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
