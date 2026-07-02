# Couples Habit Tracker — Technical Handoff Document

**Status**: Pre-repo bootstrap · **Target stack**: TanStack Start on Cloudflare Workers, Durable Objects, D1 · **Date**: July 2026

---

## 1. Application Description

A private, real-time habit and protocol tracker for couples in dedicated, long-term D/s relationships. The app gives each couple a shared, role-aware system of **events, rules, counters, and timers** for tracking rituals, tasks, infractions, and intimate dynamics — with an append-only event log that doubles as a transparent consent record both partners can review.

### Positioning

- **Couples-first**: both partners have accounts bound into one shared dynamic; views are role-asymmetric (dom sees an assignment/review dashboard, sub sees a protocol checklist) but derived from the same data.
- **Safety- and consent-first**: the event log is an auditable relationship record; adjudication flows build communication into the mechanics; nothing is surveillance-based (honor-system self-report within a trust relationship).
- **Privacy as a headline feature**: no email, no password, no account in the traditional sense. Each couple's data lives in its own isolated per-couple database. Deletion is total and provable.
- **LDR-native**: async adjudication queues, live-synced timers, and ambient co-presence are first-class, not bolted on.

### Explicit non-goals for v1

- No scoring/rewards/punishments engine (deferred — the event substrate is designed so this layer is pure composition later).
- No photo proof, location, or any surveillance mechanics.
- No cross-couple features, discovery, or social anything.
- No aggregate analytics beyond opt-in, near-zero telemetry.

---

## 2. Identity Model (No-Email / Recovery-Token)

Same philosophy as the kink survey tool; the routing layer is nearly copy-paste.

### Root identity

1. On first launch, the client generates a high-entropy secret. The server stores only a hash (treat like a password hash).
2. The secret is presented to the user as a **BIP39-style recovery phrase** — framed explicitly: *"This is your only key. We can't reset it because we don't know who you are — that's the point."*
3. The secret (or derived device tokens, below) is the bearer credential in an `Authorization` header.
4. No email, phone, or OAuth anywhere in the system.

### Device tokens

- An authenticated device can mint additional per-device tokens, each individually revocable.
- Device list lives in the member's record **inside the couple DO**; a "your devices" panel supports "log out that device."
- The recovery phrase becomes a rarely-used root credential; day-to-day auth is device tokens.

### Pairing flow

1. Partner A creates the couple → DO instantiated with A as sole member.
2. DO generates a **short-lived (minutes), single-use invite code** (QR / deep link). Rate-limited; it is briefly a bearer credential for joining a relationship.
3. Partner B creates their own local identity, redeems the code; DO binds B's identity hash as the second member and **permanently closes invitations**.
4. Roles (dom/sub/switch or custom labels) assigned inside the DO via a **mutual-confirmation step** — both must confirm before the dynamic activates. This confirmation is the first entry in the agreement/consent history.

### Recovery

- **Partner-assisted recovery**: lost token → user creates a fresh identity, requests rejoin; the other partner (authenticated in the DO) approves; DO rebinds the member slot to the new identity hash and revokes the old one.
- **Mandatory friction**: partner approval **plus a 24–48h waiting period**, with notice pushed to the old identity's remaining devices. Converts a stolen-phone scenario into an interruptible event.
- **Both tokens lost** → data is unrecoverable. Document this proudly, not apologetically.

### Abuse-edge mitigations (build day one)

- Any member can always **export their own data** while authenticated; encourage periodic local export.
- Either member can unilaterally **dissolve the pairing**: freezes the dynamic, offers each side an export, then deletes. No one can be trapped inside the app's structure. (Safeword philosophy applied to the identity layer.)

---

## 3. Architecture

### 3.1 Topology

```
Browser (TanStack Start SPA/SSR)
   │  HTTPS + WebSocket
   ▼
Cloudflare Worker (TanStack Start server, API routes)
   │  ├── D1: identity routing (identity_hash → couple_do_id, device token hashes)
   │  └── Durable Object: CoupleDO  ←— one per couple, SQLite-backed
   ▼
CoupleDO owns: members, roles, devices, invite/recovery state,
event log, amendments, rules, projections (counters/timers),
event-type schemas, alarms, WebSocket sessions
```

### 3.2 Couple-as-Durable-Object

**One SQLite-backed DO per couple** is the core architectural decision.

- All relationship data lives in that couple's private embedded SQLite. No `WHERE couple_id = ?`, no cross-tenant leak surface, no contention. *"Your relationship's data lives in its own isolated database, physically separate from every other couple"* is a marketable claim.
- **Serialized correctness where it matters**: pairing, member rebinding, device revocation, event append → rule evaluation → projection update → WebSocket broadcast all happen in one serialized event-loop turn. Projections cannot drift from the log mid-flight. The safeword/pause-everything action is a single serialized state transition.
- **WebSockets with the hibernation API**: both partners hold sockets into the same DO for live sync (countdowns ticking on both screens, dom seeing a stopwatch running now on the sub's device). Hibernation keeps idle-connection cost near zero — essential at two long-idle connections per couple.
- **Alarms replace cron**: each DO maintains a small internal schedule table (`next_fire_at` per scheduled item: counter resets at day/week rollover, streak evaluation, check-in reminders, agreement-renewal nudges) and always arms its **single alarm** at `MIN(next_fire_at)`. On fire: process everything due, reschedule. Dormant couples cost nothing.
- **Location**: set `locationHint` at couple creation from the founding partner's region. Acceptable tradeoff: an LDR couple split across continents means one partner eats ~150ms+ RTT — fine for a habit tracker; do not promise latency parity.

### 3.3 What lives outside the DO

| Concern | Where | Notes |
|---|---|---|
| Identity → DO routing | D1 (or KV) | `identity_hash → couple_do_id` + device token hashes. Knows *nothing else* — membership lookup happens inside the DO, so the routing DB cannot enumerate couples' contents. |
| Template / content library | Static assets or KV | Global, read-heavy, editorially controlled. Starter event types, rule packs, protocol templates. |
| Aggregate analytics | Workers Analytics Engine (opt-in only) | Keep this surface as close to zero as possible; minimal analytics is a trust feature. |

### 3.4 TanStack Start integration

- Deploy TanStack Start via its Cloudflare Workers target (`wrangler` + the Cloudflare preset in `vite.config`); server functions and API routes run in the Worker alongside the DO binding.
- **Server functions / API routes** handle: identity creation, token auth, invite redemption, and proxying commands to the CoupleDO (`env.COUPLE_DO.get(id).fetch(...)` or RPC).
- **WebSocket route**: a Worker route upgrades and forwards the socket to the DO (`fetch` with upgrade → DO `webSocketMessage`/hibernation handlers). Client subscribes once; all live state (timer ticks, projection changes, queue badge counts) flows over it.
- **Client state**: TanStack Query for command/response; a thin WebSocket-driven store for live projections. Server-render the shell + static/marketing pages; the app surface is effectively a live client app after auth.
- Suggested repo layout:

```
/app                 TanStack Start app (routes, components, client stores)
/worker
  /do/CoupleDO.ts    the Durable Object class
  /routes/api        server routes: auth, invite, command proxy, ws upgrade
/shared              zod schemas: event types, amendments, rules, ws protocol
/templates           starter seven + default rule pack (JSON, versioned)
/migrations
  /d1                routing-layer migrations
  /do                per-DO idempotent migrations (see 3.5)
wrangler.toml        DO binding + migration tags, D1 binding, KV (optional)
```

### 3.5 Operational disciplines (decided now, painful later)

- **Per-DO schema migrations**: version-stamp the schema inside each DO's storage; run idempotent migrations lazily on wake. Keep `/migrations/do` as an ordered list of idempotent steps.
- **Support introspection**: build a small internal, audit-logged endpoint on the DO early ("why did this streak reset") — there is no global query escape hatch by design.
- **Export**: a user-facing export (JSON of the member's view of the log + projections) is a feature you write, not a dashboard button. Required for the abuse-edge mitigation above.
- **Deletion**: dissolve → export offers → delete the DO → purge the two routing rows. *"Delete your account and the database containing your relationship's data ceases to exist."* Make this literally true.
- **Discretion**: neutral app name/icon candidates, PIN lock, and content-free notifications ("You have 1 new item") are product requirements, not polish.

---

## 4. Core Primitives

Five primitives, one mechanism: **events** (the truth), **amendments** (rulings and corrections), **rules** (the wiring), **counters** and **timers** (derived views).

### 4.1 Events — the source of truth

Append-only, human-authored log. Rules never create events (no cascades, no loops; the log's integrity as a consent record is preserved).

Event fields:

| Field | Notes |
|---|---|
| `id` | ULID |
| `type` | from the couple's event-type schema set |
| `actor` | who logged it |
| `subject` | who it's about (dom can log about sub); required per type schema |
| `occurred_at` / `logged_at` | **separate fields** — backfill ("forgot to log this morning") is common; time-anchored effects use `occurred_at` |
| `metadata` | typed key/values per schema (boolean, enum, number, ref only — no freeform strings; prose goes in `note`) |
| `note` | freeform text |

**Direct manipulation is sugar over events**: a "+1" tap on a counter emits `type: counter_adjusted`. Everything is an event; users only meet the rules machinery when they want it.

### 4.2 Amendments

Events are never mutated or deleted. Post-hoc changes are amendment records:

- `adjudication`: `target_event_id`, metadata patch (only keys the actor's role is `adjudicated_by` for), optional note, `supersedes: amendment_id` for corrections. One active ruling per key; corrections supersede, never delete.
- `note_appended`: sub adds context to their own pending event; no rule effects.
- `retracted`: sub-authored, allowed only while the event is pending; removes from queue, marks in log. **There is no deletion** — retraction frequency is itself visible relationship data.

**Composite state**: current event state = original metadata overlaid by amendments in timestamp order, latest non-superseded wins per key. Derived, never stored.

**Re-evaluation on amendment**: when an adjudication lands, the engine re-evaluates the *target* event with merged metadata, firing rules that now match and didn't before. Fires effects only — an amendment cannot trigger further events. Time-anchored effects (anchor resets) use the target's `occurred_at`, not the ruling time. Timer effects from amendments apply only if the timer is still active; otherwise log a trace note ("R14 skipped: denial_period already ended"). No retroactive timer surgery.

### 4.3 Rules

`when event.type = X [AND metadata equality conditions] → [effects list]`

- **Condition language is deliberately dumb**: equality on `type` and metadata keys. Absent key ⇒ conditional rules silently skip (this is load-bearing — see adjudication). No expressions, no thresholds, no state queries in v1.
- **Effect verbs (all four exist in v1)**: `increment/decrement counter`, `reset counter`, `reset elapsed-since anchor`, `open/close timer` (with match-on-ref, e.g. `timer.task_id = event.task_id`, and a close status: completed/failed).
- Rules support **multiple effects per rule** (effects is a list).
- **Rules route values; they never compute them.** (e.g., a stopwatch's derived duration lands in a counter because the timer close produced it — the rule only says where it goes.)
- Rule creation validates against the event-type schema (conditioning on a nonexistent key fails at creation, not silently at runtime).
- **Flagged v2 extension (do not build yet)**: a single bounded state predicate `timer_active(X)` — e.g., "unpermitted orgasm is worse during an active denial period." V1 handles this with flat effects + human response.

### 4.4 Counters

- Fields: name, valence (positive/negative/neutral — drives display and later scoring hooks), optional daily/weekly target, reset semantics, per-counter modify permissions.
- **Reset semantics** (first-class property): never / on schedule (daily, weekly) / on acknowledgment / manual-with-note.
- **Materialized value is a cache**: current value is stored in the DO for cheap reads and live sync, but is rebuildable by event replay.
- **Streaks are built into target-counters, not rules**: at day rollover the DO alarm evaluates "target met? streak +1 : streak = 0" and writes a system-visible outcome into the trace log. Rules react to events; schedules belong to projection definitions.

### 4.5 Timers

Three flavors:

- **Stopwatches (accumulating)**: paired `session_started`/`session_ended` events sharing a `session_id`; DO holds in-flight state; duration derived on close. Handle failure modes explicitly: `ended` with no matching `started` → reject with trace note; session left running past a per-activity max → auto-close flagged for review.
- **Countdowns (deadline)**: created at assignment (e.g., per-task), terminal event `completed` or `failed`/`expired` — the future consequence hook. **Pause and extend by the dom are day-one features**; life intrudes, and rigid timers punish people for having jobs.
- **Elapsed-since anchors**: an anchor timestamp + live display ("days since last infraction"). Reset by rule effect. Trivial, disproportionately loved.

Timers carry the same permission model as counters (who starts/stops/pauses matters as much as the clock: sub-controlled stopwatch = self-report; dom-started countdown = assignment).

### 4.6 Trace / transparency (non-negotiable)

Every projection change records `caused_by: {event_id, rule_id | system_job}`. Tapping any counter/timer or any event shows the full chain: original log → amendments in order → rules fired at each step (including **near-misses**: "R12 didn't fire: `permitted` not set") → projections touched. The consent-record view and the debugging view are the same screen. Cheap now, prohibitive to retrofit.

---

## 5. Event-Type Schema Format

Stored per-couple in the DO; starter seven ship as defaults; custom types are first-class and identical in shape.

```json
{
  "id": "orgasm",
  "label": "Orgasm",
  "icon": "…",
  "valence": "neutral",
  "log_permission": ["dom", "sub"],
  "subject_required": true,
  "metadata": {
    "permitted": {
      "kind": "boolean",
      "label": "Permitted?",
      "required": false,
      "set_permission": ["dom", "sub"],
      "adjudicated_by": ["dom"]
    },
    "outcome": {
      "kind": "enum",
      "options": ["full", "ruined", "denied"],
      "required": true,
      "set_permission": ["dom", "sub"]
    }
  },
  "awaiting": ["permitted"],
  "note_prompt": "Anything you want to say about this?"
}
```

Schema semantics:

- **`awaiting`** — list of metadata keys. An event with any `awaiting` key unset in its composite state is **pending** (derived status, never stored). This single property *is* the adjudication-queue mechanism.
- **Two permissions per metadata key**: `set_permission` (at logging time) and `adjudicated_by` (via amendment afterward). Example: sub may set `permitted` when logging ("you told me I could this morning"); only the dom may rule after the fact.
- **Metadata kinds**: `boolean | enum | number | ref` only.
- **Valence on the type**, overridable per rule effect.

---

## 6. Starter Seven Event Types

Chosen so each stresses a different part of the machinery. Acceptance test: **every default projection must derive from only these seven.**

| # | Type | Metadata | What it pressure-tests |
|---|---|---|---|
| 1 | `ritual_completed` | `ritual_id` (ref), `late` (bool, optional) | Target counters, scheduled resets/streaks, metadata-conditional rules |
| 2 | `task_completed` | `task_id` (ref), `quality` (enum: exceeded/met/partial, optional, `awaiting`, dom-adjudicated) | Event→timer wiring (close countdown by ref match); grading via adjudication |
| 3 | `infraction` | `rule_ref` (ref), `severity` (enum: minor/major, `awaiting` when sub-logged, dom-adjudicated), `self_reported` (bool) | Negative valence, anchor resets, honesty-incentive rule gaps, confession→classification flow |
| 4 | `orgasm` | `permitted` (bool, optional, `awaiting`, dom-adjudicated), `outcome` (enum: full/ruined/denied) | Maximum fan-out (4–5 rules per append), pending-adjudication LDR flow, denied-≠-reset nuance |
| 5 | `session_started` / `session_ended` | `activity` (enum: kneeling/service/wear/scene), `session_id` (ref) | Paired-event stopwatches, in-flight DO state, failure modes |
| 6 | `check_in` | `mood` (number 1–5), `flag` (enum: wants_conversation, optional) | Journal-weight events, the one notify effect, wellbeing surface |
| 7 | `note` | none (tags optional) | System tolerates zero-effect events; praise/context live here |

**Adjudication generalizes across #2, #3, #4 via `awaiting`** — one mechanism, three starter use cases.

---

## 7. Default Projections & Rule Pack

### Projections

**Counters**: `rituals_completed_today` (target, daily reset) · `ritual_streak_days` (system-managed streak) · `tasks_completed` · `demerits` (resets on acknowledgment) · `infractions_lifetime` · `orgasms_lifetime` · `orgasms_permitted` · `orgasms_unpermitted` · `orgasms_denied` · `service_minutes_week` (weekly reset) · `check_ins_week` (weekly reset)

**Anchors**: `since_last_infraction` · `since_last_orgasm` · `since_last_check_in`

**Timers**: per-task countdowns (created at assignment) · per-activity stopwatches · optional `denial_period` countdown

### Rules R1–R18

| ID | Condition | Effects |
|---|---|---|
| R1 | `ritual_completed` | `rituals_completed_today` +1 |
| R2 | `ritual_completed AND late=true` | `demerits` +1 |
| R3 | `task_completed` | `tasks_completed` +1 |
| R4 | `task_completed` | close countdown where `timer.task_id = event.task_id`, status `completed` |
| R5 | `task_completed AND quality=partial` | `demerits` +1 |
| R6 | `infraction` | `infractions_lifetime` +1 |
| R7 | `infraction` | reset anchor `since_last_infraction` |
| R8 | `infraction AND severity=major` | `demerits` +2 |
| R9 | `infraction AND severity=minor AND self_reported=false` | `demerits` +1 |
| — | *(deliberate gap: minor + self-reported adds no demerits — the honesty incentive, expressed purely by rule absence)* | |
| R10 | `orgasm` | `orgasms_lifetime` +1 |
| R11 | `orgasm AND permitted=true AND outcome=full` | `orgasms_permitted` +1; reset anchor `since_last_orgasm` |
| R12 | `orgasm AND permitted=false` | `orgasms_unpermitted` +1; reset anchor `since_last_orgasm`; `demerits` +2; reset anchor `since_last_infraction` |
| R13 | `orgasm AND outcome=denied` | `orgasms_denied` +1 *(no anchor reset — the point)* |
| R14 | `orgasm AND permitted=false` | close countdown `denial_period`, status `failed` (no-op if none active) |
| R15 | `session_started` | open stopwatch keyed by `session_id`, tagged `activity` |
| R16 | `session_ended` | close stopwatch where `timer.session_id = event.session_id`; add derived duration to `service_minutes_week` if `activity=service` |
| R17 | `check_in` | `check_ins_week` +1; reset anchor `since_last_check_in` |
| R18 | `check_in AND flag=wants_conversation` | notify partner (v1: highlighted item in the today view) |

`note` — no rules; silence is allowed by design.

### Adjudication interaction with rules

- Pending events **still fire their unconditional rules** (R3, R6, R10) and appear in the log normally. The queue is a lens over the log, not a holding pen before it.
- Conditional rules (R11/R12, R5, R8/R9) fire at **adjudication time** via composite re-evaluation.
- Anchor resets fired via amendment use the original event's `occurred_at`.
- Near-miss traces make pending state legible: "R11/R12 waiting on: permitted."

---

## 8. Adjudication Queue — UX Spec

### Dom side

1. **Entry**: badge on today view — "2 awaiting your ruling." All notification surfaces are content-free.
2. **Queue screen**: reverse-chronological cards — type icon + label, subject, `occurred_at` ("last night, 11:03pm") **and** time-in-queue ("waiting 9h" — gentle dominance-as-practice pressure, no nagging), sub's note verbatim, awaited key(s).
3. **Ruling**: awaited key renders by kind — boolean as two large buttons, enum as segmented control. Optional response note.
4. **Confirm sheet shows mechanical fallout before commit**: "This will fire: +1 unpermitted orgasms, +2 demerits, reset good-behavior streak, mark denial period failed." (Forward-running trace. V1: visibility only, no effect-waiving — waivers are a scoring-layer concern.)
5. **Post-ruling**: card animates out; event shows ruling inline with both timestamps in the main log.

### Sub side

- Logging an adjudicable event without the awaited key → quiet "awaiting ruling" chip on their log entry. No countdowns, no anxiety mechanics.
- On ruling: content-safe notification ("You have an update"); event updates in place with the dom's note. Small deliberate reveal interaction — receiving the ruling is emotionally load-bearing in LDR play.
- Sub can view but never act on the queue; can append context to their own pending event (`note_appended` amendment, no effects); can `retract` while pending.

### Both sides

- Tapping any event → full chain: original → amendments in order → rules fired at each step (incl. near-misses) → projections touched.

---

## 9. V1 UI Surfaces

1. **Onboarding**: identity creation + recovery-phrase ceremony → create-or-join couple → invite/redeem → mutual role confirmation.
2. **Today view (per role)**: active countdowns, running stopwatches, today's counter targets, adjudication badge (dom) / pending chips (sub), R18 conversation flags. This one screen is the MVP.
3. **Log**: append-only event stream with composite states, amendments, trace drill-in.
4. **Log-an-event sheet**: type picker (starter seven + custom), schema-driven metadata form, note.
5. **Adjudication queue** (dom).
6. **Projections detail**: counter/timer history with caused-by chains.
7. **Settings**: event-type & rule editors (schema-validated), devices panel, pause-everything, export, dissolve.

**Pause-everything (safeword) is v1, not later**: either partner, one tap, no questions — freezes all tracking, suspends alarms and countdowns without logging failures, surfaces a reconnection flow. In the DO this is a single serialized state transition.

---

## 10. Build Order

| Phase | Scope |
|---|---|
| 0 | Repo scaffold: TanStack Start + wrangler, D1 routing schema, CoupleDO skeleton, WS upgrade path, shared zod schemas |
| 1 | Identity + pairing: token creation/hashing, device tokens, invite flow, mutual confirmation, dissolve/export stubs |
| 2 | Event log + counters: append, `counter_adjusted` sugar, materialized values, trace records, log UI |
| 3 | Rules engine: R1–R18 as installable template, schema validation, near-miss traces |
| 4 | Timers + alarms: stopwatches, countdowns, elapsed-since, the single-alarm scheduler, streak rollover, resets |
| 5 | Amendments + adjudication queue: composite state, re-evaluation, queue UX both sides, retraction |
| 6 | Hardening: pause-everything, partner-assisted recovery w/ waiting period, PIN lock, content-free notifications, export/delete for real, per-DO migrations |

Each phase ships something usable; a couple could live on phase 2 alone (shared tallies with history).

## 11. Open Decisions (intentionally unresolved)

- **Naming/positioning** — still open from earlier product threads.
- **Scoring/rewards/consequences layer** — deferred; it is "just another event consumer" plus effect-waivers on the confirm sheet.
- **`timer_active(X)` predicate** — the one approved v2 rule-language extension; do not generalize beyond it.
- **Notification transport** (push vs. in-app only) — discretion requirements constrain this heavily; in-app-only is an acceptable v1.
- **strawberrypatch.love integration** — educational interstitials, template editorial pipeline, and eventual survey-taxonomy sharing are post-v1.
