---
status: proposed
---

# Every originating ref is a server-minted identity

_Decided while building the ref pickers (#89), which ships an interim mitigation.
Implemented by #113 — merging that flips this to `accepted`._

Building the ref pickers (#89) forced the question of which refs a picker can
offer, and the answer split the `ref` metadata kind cleanly in two: an
**originating ref** names an id for the first time, an **echoing ref** repeats
one to pair with it. Only an echoing ref has candidates. But the originating
side turned out to be three different acts wearing one word: `prompt_id` is
minted by the server (#102), `session_id` is minted client-side by the stopwatch
panel's `ulid()`, and `task_id` is not minted at all — it is a short name the dom
types into the assign form, which the engine then matches on as though it were an
identity.

That third case is a latent bug, not a style difference. Assign "dishes" on
Monday and again on Tuesday while Monday's countdown is still running and there
are two `task_countdown` rows with identical match state. A close resolves
oldest-open-wins, so Tuesday's completion discharges Monday's countdown; the
picker, deduplicating by value, can only offer one "dishes" and must guess which
row to describe. No amount of UI care fixes this, because the model has no way to
tell the two tasks apart.

We decided that **every originating ref is minted by the server** — `minted: true`
on the field, a fresh ULID assigned in `appendEvent`, never accepted from a
client — and that the human label the dom types becomes ordinary display data
(`task_name`) rather than the matching key. `minted: true` then means exactly
"this is an originating ref", and the picker's rule becomes mechanical: a minted
field is hidden from the form, every other ref either has candidates or falls
back to free text.

Consequences worth stating:

- **A ref stops being readable.** A countdown row that showed `dishes` now holds
  a ULID, so every surface that displays a `task_id` must display the name
  instead. That is a real loss in the log's raw form (an exported event carries
  `task_id: 01JB6…`), accepted because a colliding identity is worse than an
  opaque one.
- **The composer stops demanding a hand-typed `session_id`.** Logging
  `session_started` outside the stopwatch panel currently requires inventing an
  id by hand — a required free-text ref that can have no candidates, since the
  event *is* the origin. Minting removes the worst instance of the problem #89
  set out to fix.
- **The client stops minting.** `stopwatches-panel.tsx` drops its `ulid()`; the
  server rejects a supplied value on a minted field, so this is not optional.
- **Old events keep their hand-typed ids.** Minting precedes persistence, so a
  rebuild replays whatever an event stored. Pre-change events keep names as ids
  forever and can still collide with each other; nothing rewrites history.

Rejected alternatives:

- **Keep `task_id` human and make the picker honest about collisions** (label
  from the oldest open row, say "2 open"). This is what #89 ships as an interim,
  and it is strictly a mitigation: the ambiguity is still there, the author is
  just told about it. It also leaves `minted: true` covering only some
  originating refs, so the picker's rule stays a special case per key.
- **Enforce uniqueness on the typed name instead of minting.** Rejected: it
  forbids assigning the same chore twice, which is a normal thing to want, and
  pushes an identity constraint onto a label the couple chose for readability.
- **Client-minted ULIDs everywhere.** Uniqueness holds wherever a ULID is made,
  and it saves a round trip before a stopwatch starts. Rejected because there is
  no offline write path to benefit, and it would leave two mint sites — so
  `minted: true` could not be the marker of an originating ref, and every reader
  would have to know which fields the client happens to fill.
