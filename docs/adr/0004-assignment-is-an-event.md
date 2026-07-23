# Assignment is an event; countdown-opening is unified on rules

Wiring up the countdown UI exposed that a task "assignment" had no home in the
model. A `task_countdown` was opened by a dom **command** (`assignCountdown`)
that logged no event: the assignment carried no prose the sub could read, left
no rebuildable record in the log, and sat off to the side of the consent spine
as an off-log `dom_command` trace row. Meanwhile `journal_prompt` — the parallel
"dom poses something to the sub" act — *is* a first-class event that opens its
countdown via a rule (R19). Tasks and journaling had drifted into two different
mechanisms for the same shape.

We decided that **assigning is logging a dom-authored event**, and that **every
countdown is opened by a rule firing on such an event** — never by a bespoke
command. Concretely:

- **`task_assigned`** — dom-authored, `note` = the instruction prose,
  `task_id` in metadata, `duration_ms` in metadata. A pack rule opens
  `task_countdown` on it; the sub's `task_completed` closes it by `task_id`
  match (existing R4). Always `shared`, not journaling-capable — a control
  record, like `infraction`.
- **`denial_started`** — the same shape minus the ref/completion pairing
  (optional `note`, `duration_ms`). A pack rule opens `denial_period`; it is
  closed `failed` by a violation (existing R14) or reaches its deadline as a
  success. This also *finishes* `denial_period`, which previously had a close
  rule but no opener at all.
- **`assignCountdown` is retired.** The dom's live control gestures over a
  running countdown — `pause`, `resume`, `extend`, and a new `cancelTimer`
  (terminal `canceled`) — stay commands (`dom_command` trace cause). The line
  is: the **record** of what was imposed is an event; **live manipulation** of
  the running countdown is a command.

Rejected alternatives:

- **Keep the command, bolt prose onto the countdown row.** Leaves the
  assignment off-log and non-rebuildable, keeps two parallel opening mechanisms
  forever, and overloads the display `tag` as an instruction field.
- **Event of record *plus* a command to open the countdown.** Avoids the engine
  change below but keeps the countdown off-log and non-rebuildable behind a
  redundant second write; the cache stops being provably a cache.
- **Fold denial into a task-shaped event.** Denial has no prose instruction and
  no completion; forcing `task_id`/pairing onto it models an imposed *state* as
  if it were an action the sub performs.

## The `duration_from` engine extension

A rule-opened countdown could not carry a *per-assignment* deadline: the
`open_timer` effect op routes `timer`, `match_on`, and `tag` only — there is no
path for a per-event duration through the pure engine. This is why every journal
prompt shares one fixed `DEFAULT_JOURNAL_DEADLINE_MS` (24h). Tasks need varied
deadlines, so we add **`duration_from`** to `open_timer`, mirroring the existing
`tag_from`: it names a metadata key (`duration_ms`) the engine reads off the
event so the rule opens the countdown to `occurred_at + duration_ms`.

This holds the "rules route values, never compute them" line — `duration_from`
routes an existing metadata value exactly as `tag_from` does; the deadline
arithmetic already lives in the countdown projection. Duration is relative
(`duration_ms`), not an absolute `due_at`, because a reusable task-catalog entry
stores "due N after assignment", not a wall-clock time; absolute "due at" stays
a UI affordance that converts to a duration at assign time.

## Consequences

- The pure engine changes (`resolveEffect` / the `open_timer` op gain
  `duration_from`), so this needs the same care and unit coverage as any engine
  change; `src/shared/timers.test.ts` / engine tests are the mirror.
- Two new pack event types (`task_assigned`, `denial_started`) and two new pack
  open-rules; R4 (task close) and R14 (denial close) are unchanged. Forward-only
  effective-dated rules as always (ADR 0002).
- The assign action is **not** an HTTP timer route — it flows through the
  existing event-logging path. Only the live-control verbs
  (list/pause/resume/extend/cancel) are timer routes/commands.
- `assignCountdown` and its input schema are removed; `dom_command` as a trace
  cause survives on pause/resume/extend/cancel.
- **Journal prompts do not yet adopt `duration_from`.** They keep the 24h fixed
  default for now; carrying a per-prompt deadline is a fast follow-up in ADR
  0001's area, deliberately out of scope here.
- **A reusable task catalog** ("templates") is now a clean future addition:
  `task_id` becomes a reference to a catalog entry, and an entry stores the
  prose + relative `duration_ms` that a `task_assigned` event is instantiated
  from. No catalog is built here.
- Acknowledge/decline (a sub read-receipt or refusal) remain unmodeled — a
  separate consent-design pass, partially covered today by pause-everything.
