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
- **Rule** — `when type = X [AND metadata constraints] [AND ambient state] →
  effects`. Routes values; it never computes them. The condition language admits
  what the event carries, who it is about, and what was *running* when it
  happened — never a count, an elapsed time, or a query over the log (ADR 0011).
  A stable rule id carries one or more effective-dated **rule versions**;
  authoring is dom/switch-only.
  _Avoid_: conflating with the **Agreement** an `infraction` cites — machine
  automation, not a term the couple agreed (ADR 0006).
- **Effect** — one op a fired rule routes: counter increment/decrement/reset,
  anchor reset, timer open/close, notify.
- **Ambient-state predicate** — the condition clause matching on what was
  *running* when an event happened: `timer_active`, a map of timer definition to
  expected activity (`{ denial_period: true }`, `{ session_stopwatch: false }`).
  The one extension #48 reserved and the only state query the language admits
  (ADR 0011) — it makes a **timer** ambient context, not just a projection, so a
  couple can score an act by the mode they were in rather than by a key the
  author remembered to set. Names a **definition**, never an instance ("is *a*
  `task_countdown` open", not "is this task's"), and is boolean — no count, no
  remaining time. Resolved by the *caller* and passed in the rule context exactly
  as a **subject-role qualifier** is, so the engine stays storage-free and the
  dom's confirm-sheet preview agrees with the DO. Resolved from each timer's
  durable **span** (`opened_at`/`closed_at`) rather than its current status, as
  of the event's **`occurred_at`** — so a ruling a week late still asks what was
  running when the act happened, on the same clock an anchor reset and a citing
  ref already use. A **paused** countdown is active: a pause freezes the clock,
  it does not end the denial. _Avoid_: "state predicate" unqualified — the
  elapsed and counter forms are refused, not pending; "mode" as a separate
  primitive, since a timer already is one; reading the predicate off `status`,
  which a rebuild resets.
- **Comparison clause** — a numeric constraint (`{ mood: { op: "lte", value: 2 } }`)
  standing in for a metadata key's bare equality value. **Not** a state query:
  still a pure fold over the event. The right side is always a *literal* — a
  clause naming a second key would be computation, and rules route values rather
  than computing them. Legal only on a `number` field, refused at creation
  otherwise. It replaces the value on the `metadata` map rather than living in a
  parallel map, so one key can never carry two contradictory constraints.
  _Avoid_: "threshold" — a counter threshold is the refused form, and belongs to
  the deferred scoring layer (#47); "expression".
- **Rule version** — an effective-dated revision of a rule's **name**, condition,
  and effects. Rules are append-only-versioned: editing adds a version (with an
  `effective_from`), never rewriting the prior, so replay picks the version in force
  at an event's **log-time** (when it fired). The name versions with the rest, as an
  Agreement version's does, so a rename is not retroactive: a revision row and a past
  change notice keep saying what the rule was called then (ADR 0009). It is display
  copy — the engine never reads it, the trace still cites the stable **id**, and
  reconciliation ignores it, so renaming a pack rule is not an upstream change.
  _Avoid_: "edit" as if a rule mutates in place; the id as a stand-in for the name.
- **Effective-dating** — a versioned definition governs only what happened while it
  was in force. Changes are **forward-only**: the past keeps the consequences it
  received, and a rebuild re-derives under the version current *then* — reproducing
  history, not rewriting it. Three things carry versions, and each resolves against
  a different clock: a **rule** at an event's log-time (ADR 0002), an **Agreement**
  at an event's `occurred_at` (ADR 0006), and a **counter** at the rollover boundary
  being folded (ADR 0013), since a counter's policy is read by a system job rather
  than by any event. _Avoid_: "retroactive" changes; treating the clock as an
  implementation detail — it is the semantics.
- **Adopted rule** — a default-pack rule (`R#`) a couple has edited. Adoption freezes
  it against upstream: a pack version bump no longer overwrites its definition (only
  surfaces an upstream-changed notice), while un-adopted pack rules still track the
  pack. _Avoid_: "forked", "overridden".
- **Agreement** — a term the couple has agreed, held in a per-couple corpus and
  cited by events (an `infraction`'s `rule_ref`, a `ritual_completed`'s
  `ritual_id`). A human agreement, *not* an engine **Rule**; the two shared the
  word "rule" and must not be conflated (ADR 0006). Always shared — never carries
  the journaling visibility axis. Carries a **subject** — the member it is about —
  exactly as an event does, so aboutness and authorship stay independent axes here
  too (ADR 0010). _Avoid_: "rule" for an Agreement; "policy", "contract".
- **Agreement kind** — a per-couple definition classifying an Agreement
  (`protocol`, `ritual`, `limit`, `safeword`, or the couple's own), carrying an
  **author scope** and the role list that may hold entries of that kind. The role
  list says who may *have* such a term; the scope says which member may move a
  given one (ADR 0010). An Agreement's kind, and a kind's author list, may only be
  set to one the actor already holds; a kind's author scope never changes, and
  neither does the author list of a `subject`-scoped kind — a couple must not be
  able to configure away the other's ability to record a boundary. An **empty**
  author list is refused outright: nobody could hold such a term, and nobody could
  undo it. _Avoid_: "category", "type" (an **event type** is a different thing);
  treating kind as display-only; "the role list decides who may edit these".
- **Author scope** — how an Agreement kind narrows authorship from its role list
  to a member: `subject` (only the member it is about — `limit`), `counterpart`
  (anyone in the list except that member — `protocol`, `ritual`), or `unscoped`
  (the role list alone, subject absent — `safeword`). Set with the kind and
  **immutable**: flipping a scope would convert every existing entry in one write,
  and narrowing to `subject` would leave subjectless entries with no author at all.
  A `subject`-scoped kind's **role list is fixed too** — the widening that put a dom
  into `limit` also gave them the ADR 0006 right to edit that list, which would let
  them narrow it and stop the sub recording a boundary at all.
  A role list alone cannot express this — in a switch+sub couple it made the sub's
  limits editable by the switch, and in dom+switch it let the switch rewrite their
  own protocols. _Avoid_: "permission" for the scope (`author_permission` is the
  role list); "owner" (the **subject** is the fact, ownership is derived).
- **Protocol** — the Agreement kind for a standing expectation the sub is held to
  and can break. One kind among several, not the name of the corpus. _Avoid_:
  "Protocol" for the whole corpus (a limit is its subject's own boundary, so the
  "sub is held to it" definition was never true of one).
- **Agreement version** — an effective-dated revision carrying the entry's **name
  and prose together**, so a rename is never retroactive. `kind` and **subject**
  sit on the identity and never version — a versioned subject would let a revision
  move a limit to its author and own it outright (ADR 0010). An Agreement is *in
  force* or *retired*; a version dated ahead is the announced draft, and there is
  no private draft state. _Avoid_: "draft" as a status; "delete" (retire, unless
  nothing ever cited it).
- **Review nudge** — an Agreement's optional review cadence, firing through the
  DO's schedule table as a prompt to revisit the term together. It **never lapses**
  an Agreement: an unanswered nudge leaves the term in force, because a lapse would
  remove a term neither partner removed. _Avoid_: "renewal" as if reaffirmation
  were required; "expiry".
- **Counter / Timer / Anchor** — the three **projection** flavors: a materialized
  tally, a stopwatch/countdown, and an elapsed-since timestamp. Each is a **cache**
  rebuildable by replaying the log — with one standing exception: state no event
  records *and* nothing can reconstruct (a sweep's close, a dom's cancel or extend)
  is *preserved* across a rebuild rather than re-derived, because a sweep stamps
  the moment it noticed. Off-log state that *is* reproducible — period resets,
  streak folds — is replayed instead (ADR 0013). A rebuild resets exactly what a
  rule wrote (ADR 0012); reading "cache" as "everything here is disposable" is what
  produced five scoring-direction divergences. **Clocks** is the UI's word for the anchors
  read together ("days since …", Today since #88) — a display grouping, never a
  fourth flavor. _Avoid_: "clock" for a timer, which counts toward something
  rather than since it.
- **Projection** — any derived, materialized view of the log (a counter, timer, or
  anchor). _Avoid_: "aggregate" (DDD-loaded), "view model".
- **Stopwatch / Countdown** — the two timer flavors. A stopwatch *accumulates*
  (paired `session_started`/`session_ended` sharing a `session_id`, duration
  derived on close); a countdown is a *deadline* (opened by a rule firing on an
  event — `task_assigned`→`task_countdown`, `denial_started`→`denial_period`,
  `journal_prompt`→`journal_countdown` — routing its `duration_ms`, ADR 0004;
  terminal `completed`/`failed`/`expired`/`canceled`, dom may pause, extend, and
  cancel). _Avoid_: "session" for the stopwatch itself — a session is the pair of
  events that opens and closes one; "assign" as a *command* — a countdown is opened
  by an event, and the dom's live control (pause/resume/extend/cancel) is what
  remains a command (ADR 0004).
- **Auto-closed** — how a timer the system retired reads: a stopwatch left running
  past its per-activity max (`auto_closed`, §4.5). One word across the sessions
  panel, the closed-countdown rows, and the trace ledger. _Avoid_: "closed
  automatically", "timed out", "abandoned" as competing display words.
- **Disposition** — the terminal status a closed timer carries. A row shows its
  *display word*, never the stored one — **overdue** for `expired`, **auto-closed**
  for `auto_closed`, and the plain word for the rest (#149). `timerViewSchema.status`
  is an open string, so an unmapped disposition de-slugs rather than printing raw.
  The same two rungs — declared copy, then a de-slug — are what an **option label**
  generalizes to every enum (#155).
  _Avoid_: "outcome" (a countdown's disposition says how it ended, not how it went —
  a `completed` one may still be ruled `partial`).
- **Overdue** — how a passed deadline reads to a person, on any surface.
  `expired` is the *status* a swept countdown carries; whether the sweep has
  landed yet turns on alarm timing and polling, not on anything the author did,
  so the two never get different words in the UI. _Avoid_: "due" and "late" as
  competing display words; "overdue" as a status name.
- **Act** — an event recording *what happened* inside a scene: one `act` event per
  thing done, carrying an `act` enum (`impact`, `bondage`, `aftercare`, …), an
  optional short `detail`, and the `session_id` of the session it happened in. Its
  **subject** is the *recipient*, so direction comes free and a rule qualifies on
  `subject_role` exactly as ADR 0003 intends — a session about the sub can still
  contain an act the dom received. One type carrying an enum rather than a type per
  act, because a rule condition's `type` is a single string: with N types, "any act"
  is N rules that silently under-cover every time the vocabulary grows. Its
  **`awaiting` is empty** — an act is a record, never a ruling. Nobody adjudicates
  it, so it never reaches the **adjudication queue** or the unread count; the dom's
  engagement with one is a `response` amendment. _Avoid_: "activity" (that is the
  *session's* enum — what kind of scene it was, not what was done in it); "act" for
  the session as a whole; modeling acts as a list on `session_started`, since a
  **span** can never be individually timed, noted, or retracted.
- **Session contents** — what a session reports about itself: every non-retracted
  event echoing its `session_id`, minus the `session_started`/`session_ended` pair
  that bounds it. Read off the **metadata** rather than a type allowlist, so
  `orgasm` and `edge` — which carry the same optional `session_id` — appear beside
  an **Act** without any surface naming them, and a couple's own type scoped to the
  session appears for free. _Avoid_: "session log"; "contents" for the timer row
  itself (the row is the span, the contents are the events inside it).
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
- **Couple status** — `pairing | active | dissolved` at rest; the status readout
  says **Pairing in progress**, **Dynamic active**, **Dissolved** (#149). Each
  display word is the vocabulary entry for the state it names. _Avoid_: printing
  the stored value — "Status: active" names no state the reader can see, and
  "dissolved" is a database word for something a partner did on purpose.
- **Pairing** — the flow that binds a second member into the couple and then
  **permanently closes** to further invitations. _Avoid_: "signup"; "onboarding"
  (the UI surface, not the binding).
- **Dissolve** — either member's unilateral, unblockable termination: freeze →
  export offer → delete. _Avoid_: "cancel", "unpair", "leave".
- **Pause-everything** — either partner's one-tap freeze of all tracking (suspends
  alarms and countdowns without logging failures). The *safeword* philosophy
  expressed in the mechanics. _Avoid_: "safeword" as the feature/identifier name —
  it names the philosophy, not the mechanism.
- **Consent history** — the append-only record of **consent entries**: the mutual
  role confirmation (the first entry) and every change to an **Agreement**.
  Distinct from the log-as-consent-record framing (see Trace). _Avoid_: "agreement
  history" — an Agreement is the term itself, this is the record of it changing.

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
- **Metadata** — an event's typed key/values (`boolean | enum | number | text |
  ref` only; freeform prose lives in `note`). A `text` value is a short label the
  author types (`task_assigned`'s `task_name`) — display data a rule may route as
  a timer's tag or match by equality like any other value, but never an
  **identity**: it names nothing outside the event and pairs no two events, which
  is what separates it from a **Ref**. The boundary against `note` is length and
  intent, not type. _Avoid_: "fields", "attributes", "props".
- **Ref** — a metadata value naming something outside the event: a task, a
  session, a prompt, an Agreement. Where a ref *pairs* two events, rules match it by
  strict equality and nothing else, so a ref one character off names nothing and
  pairs with nothing — the event logs fine and the consequence silently never
  arrives. _Avoid_: "pointer", "foreign key", "link".
- **Originating ref** — the ref on the event that *mints* the id: the server
  assigns it at log time and a client may never supply one (`minted: true`,
  ADR 0005). `task_assigned`, `session_started`, `journal_prompt`.
- **Echoing ref** — a ref repeating an id minted elsewhere, in order to pair with
  it. Two flavors, differing in what they may name rather than in what the schema
  declares: a **closing echo** discharges the row it names (`task_completed`,
  `session_ended`, `journal_entry` — each closes a timer through a rule), while a
  **non-closing echo** only says which row the event belongs to (an **Act**'s
  `session_id`, and the same key on `orgasm`/`edge`). Which one an event is stays
  *derived* from the couple's own rules, never declared on the field: a rule
  matching a timer on key K is the statement "K names an existing row", and that
  holds wherever K appears. Every ref that pairs events is originating or echoing,
  and the schema flag says which. _Avoid_: "copy", "reference back"; assuming an
  echo closes something — that conflates *can this event resolve the row* with *can
  this event name the row*.
- **Citing ref** — the third flavor: a ref naming a **definition** rather than an
  id minted by an event (`infraction`'s `rule_ref`, `ritual_completed`'s
  `ritual_id` — both naming an **Agreement**). Nothing mints it at log time, and
  it resolves to the version in force at the event's **`occurred_at`** — what the
  person was bound by when they acted. This is *not* the rule-version clock, which
  is log-time (ADR 0002): the system carries two resolution clocks on purpose,
  because a rule version governs when the machine acted and an Agreement version
  governs what was agreed (ADR 0006). _Avoid_: "echoing" for a citing ref — its
  candidates and its clock both differ.
- **Unstructured ref** — a ref naming something the app holds no row for. None
  ship today: `rule_ref` and `ritual_id` became citing refs once Agreements gave
  them something to name. Free text *by nature* rather than by omission — never
  minted, never matched. A ref that gains a definition becomes citing (or an
  originating/echoing pair) like the rest.
- **Ref candidate** — an id a ref may still name; what qualifies depends on the
  flavor. For a **closing echo**: an open timer, or one that expired recently
  enough to stay in grace — echoing late still pairs the event for history even
  though it no longer closes anything, and a resolved timer (completed, canceled,
  auto-closed) is never a candidate, because *closing* it again means nothing. For
  a **non-closing echo**: the most recent rows at any status — "we did impact
  during last night's scene", logged the next morning, names a resolved row and
  means everything. Bounded by **count** rather than by a time window, because a
  window goes empty on a quiet couple and an empty list degrades the field back to
  the free-text ULID box ADR 0005 exists to remove. For a **citing** ref: the
  Agreements in force — a retired Agreement is offered for no new citation, yet
  every past citation still resolves and every rule matching it still fires on replay.
  _Avoid_: "live" (the repo's informal word for polling and ticking),
  "suggestion", "autocomplete".
- **Option label** — the display copy an enum option carries, keyed by stored
  value on the field (`option_labels`, ADR 0008). Every generic enum control and
  readout renders it — the **Disposition** rule ("a row shows its *display word*,
  never the stored one") applied to the one control that had been exempt (#155).
  Pack copy is **speaker-neutral**, because one field is read in both partners'
  voices; a surface whose register differs enough overrides locally (the sub's
  Mark-done form, #154). Unlabelled options de-slug rather than failing, so a
  couple's own event type still reads as words. _Avoid_: "display name" (an
  Agreement **version** carries one, a different thing); a label that restates
  the stored token.
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
- **Quality** — how well a task was done (`exceeded | met | partial`), the pack's
  canonical **awaiting** key on `task_completed`. Setting it *resolves* that key,
  so a sub who states their own quality is **not** asking for a ruling — the
  completion never lands pending and never reaches the dom's queue; only a blank
  puts it there, and the dom's route to a set quality is an amendment. Copy in
  the sub's own form therefore reads as a claim rather than a verdict, and says
  which of the two paths a pick takes (#154). Elsewhere it reads as the pack's
  neutral **option label** — "Beyond what was asked", not `exceeded` (#155).
  _Avoid_: "grade", "score", "rating" (see **Adjudication**); copy implying a
  self-stated quality awaits approval.
- **Notification** — the single content-free unread *count* a member polls, shown
  as a discretion-safe badge ("You have N new items"; handoff §3.5, #42): events
  awaiting *this* member's ruling, what their partner has said back about their own
  entries (a ruling or a **Response**, #183), a targeted recovery notice, and the
  partner's rule and Agreement changes — composed in one place
  (`shared/notifications.ts`). A number only, never any relationship content.
  Everything it counts is **addressed to the viewer**: a bare logged event notifies
  nobody, and one entry counts once however many times it was amended, because a
  content-free number cannot say which of six things it means. _Avoid_: "inbox" (a
  count, not a container — and the banned adjudication-queue synonym).

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
- **Response** — an amendment kind: the partner's (in practice the dom's)
  post-hoc prose *reaction* to something the other logged. A **gift, not a
  debt** — never tracked as pending/owed, never queued. Allowed on `shared`
  content (reacting to it) and `sealed` journal entries (acknowledging the act
  without the words), never on `secret` ones. On a `check_in` carrying
  `wants_conversation` a response is also what **closes the conversation flag**
  (ADR 0007). Fires no rules, does not touch composite metadata, and is
  inherently visible to the entry's author — who is *told*: a response raises
  their **Notification** count and lands behind the same content-safe reveal a
  ruling does (#183). Writable from any log row the viewer did not author and
  that is not `secret`, a gate that mirrors `validateResponse` rather than
  listing respondable **Event types** — a client-side allowlist would be a second
  answer to a question validation already answers, and would omit every type the
  pack grows next. _Avoid_: overloading `note_appended` (that is the author's own
  added context) for this; a per-type respond affordance.

- **Conversation flag** — the open state of a `check_in` carrying
  `flag=wants_conversation` (R18): open until the *other* member attaches a
  **Response**, derived from the log like **Pending** rather than stored. It never
  expires — the app cannot observe a conversation, so only a person may end one
  (ADR 0007). _Avoid_: "notification" (that is the content-free count); treating
  it as dismissable. **Conversations** is the UI's word for the open ones read
  together — Today's panel heading (#88), never a fourth amendment kind.

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
  event type is `awaiting`. An **ambient-state predicate** misses on a third
  ground — the mode was wrong — which no ruling can ever resolve, so it never
  enters `awaiting` and is surfaced only when it was the *sole* miss ("R26 didn't
  fire: no denial period was active"). Otherwise every act outside a mode would
  file a row nobody asked for.

The module owns the taxonomy end to end: pure **builders** the write side calls
(one `writeTrace` sink in `CoupleDO` does the single INSERT), the `encodeDetail`
/`decodeTraceRow` codec, and the `describeTraceRow`/`summarizeEffectOp` decoders
the UI renders through. Effect **phrasing** is shared so "what will fire" (the
dom's confirm sheet) and "what fired" (the chain view) read identically.

## Discretion (handoff §3.5, #42)

What keeps the app's *presence* from giving the relationship away, on a device
someone else may pick up. All of it is device-local and none of it is a security
boundary — the relationship data is protected by the bearer credential, not by
any of this. The **cover name** (`APP_NAME`) and the content-free **Notification**
count above belong to the same requirement.

- **PIN lock** — the device-local cover: a PIN whose hash alone is stored, gating
  the whole app behind a neutral lock screen. Deliberately not cryptography — it
  stops a casual glance, not someone who controls the device. _Avoid_: "password",
  "authentication", or any phrasing that implies it protects data.
- **Locked / unlocked** — the state of *one tab*, held for the browser session.
  Setting or entering the PIN unlocks; a fresh load, a **Lock now**, or a passed
  **auto-lock** delay covers it again. _Avoid_: "signed out" (the bearer
  credential is untouched — locking is not logging out).
- **Lock now** — covering the app on purpose, one tap in the bottom bar, for the
  moment the phone gets handed over. It reaches every tab on the device, since
  they were all handed over together. _Avoid_: "log out", "sign out".
- **Auto-lock** — the optional delay after which the app covers itself. One delay
  serves both ways it gets left, **away** and **untouched**: they are different
  waits, but a second control would ask the couple to reason about a distinction
  the lock screen never shows them. _Avoid_: "session timeout", "expiry".
- **Away** — time spent out of view (backgrounded, screen off, tab hidden),
  measured by timestamp on return rather than by any timer, since a hidden tab's
  timers are throttled or frozen. A window open in front of you is not away —
  that is **untouched**.
- **Untouched** — time the app spent in view with nobody touching it: no tap,
  key, or scroll. The desk case, and the one thing here that does need a running
  timer, because nothing announces an absence of input the way `visibilitychange`
  announces a departure. Measured across the whole device rather than per tab,
  since a lock covers every tab — the window you are *not* typing in must not
  lock the one you are. Hidden time is **away**, not untouched. _Avoid_: "idle"
  and "inactive".
