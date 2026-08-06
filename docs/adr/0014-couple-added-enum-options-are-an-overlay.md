---
status: accepted
---

# A couple's added enum options are an overlay, not an adoption

A couple could not add a word. The `act` vocabulary, `session_started.activity`,
`infraction.severity` — all frozen until a pack bump. `createEventType` let a
couple author a whole new *type*, but there was no client function for it, no
edit path, and a custom type would not have behaved as an act anyway, since
`EventType` carries no category field. ADR 0008 closed with the question in as
many words: "a future event-type editor will have to answer that question for the
whole definition, not for this field."

We decided a couple's added options are an **additive overlay** stored beside the
pack definition (`event_type_options`), merged at the DO's **type read seam**
(`eventTypeById` / `listEventTypes`). The pack keeps owning
`event_types.definition` outright, and `seedDefaults` keeps upserting it blindly.

## Why not adopt-on-edit

The obvious move is to mirror `reconcilePack` (ADR 0002, #64), which already
solves "let couples customize pack content without a bump clobbering them" for
rules. It is the wrong model here, and the reason is a difference in the *thing*
being customized rather than a difference in taste.

**A rule is one atomic statement.** Freezing it against a bump freezes exactly
one decision — the one the couple made. That is why `adopted` is honest for
rules: the unit of adoption and the unit of edit are the same unit.

**A type is a composite** — enum options, `option_labels`, `awaiting`,
`note_prompt`, permissions, `journaling`. Under the rules model, a couple who
adds one act option marks the entire `act` type adopted and stops receiving every
future pack improvement to acts. They would pay for one word with the whole type,
and neither the code nor the UI would have any way to tell them that is what
happened.

An addition is a **delta** in a way that editing a rule's condition is not, so it
can ride alongside the pack definition instead of replacing it:

```
pack:    act.options = [impact, oral, …]
overlay: act.options + [aftercare_check]
read:    merge → [impact, oral, …, aftercare_check]

a later pack bump adds act.intensity
  → the couple gets it, and aftercare_check is still there
```

It is also materially smaller. No `adopted` column, no `upstream_changed` flag,
no "new default" notice plumbing, no `seedDefaults` rework — because nothing is
ever skipped, so there is nothing to notice. `seedDefaults` stays a blind upsert,
and that stays *correct* precisely because the couple's data lives elsewhere.

## The merge belongs at the read seam and nowhere else

This is the load-bearing decision; the storage shape is downstream of it.

Two validators test enum membership and would otherwise refuse a couple's own
word outright:

- `checkMetadataValue` — `field.options.includes(value)`, run on **both** write
  paths. An event logged with a couple-added option would be refused, and so
  would a *ruling* setting one by amendment.
- `rule-validation.ts` — the same check. A rule conditioning on a couple-added
  option would be refused at creation.

Merging in the DO's two type accessors means log validation, amendment
validation, rule validation, the composer, the queue, the engine, the export and
`optionLabel` all see the merged set with **zero per-caller awareness**. Nothing
downstream can tell a couple's word from the pack's — and that
indistinguishability is the property being bought, not a side effect. It is why
this issue shipped with no changes to the engine, the composer, or any consumer.

The one surface with a legitimate need for provenance is the editor, which asks
for the unmerged overlay on its own endpoint. Putting a `couple_added` marker on
the merged type would have been the cheap version of the same thing and would
have handed every reader a distinction it must not act on.

## What an overlay must survive

An overlay outlives the definition it rides on, so `withAddedOptions` resolves
every mismatch to **inert** rather than to a throw:

- **The pack dropped the field**, or changed its kind — the addition is skipped
  and the field renders as shipped. Same graceful-degradation call as
  `optionLabel`'s de-slug rung.
- **The pack shipped the same option itself** — the pack's position and copy win.
  The option is the pack's now, so a bump that relabels it is not fighting a
  label the couple typed before it existed. The overlay row is left alone, so the
  word survives if a later bump drops it again.

## Renaming moves the label, never the token

An option has a stored **token** and a read **label**. The token is what a logged
event, a rule condition and an export carry, so renaming one would orphan every
event holding it; the label is display copy that ADR 0008 already routes through
one resolver. So the editor renames labels and mints tokens once, and the add
form shows the token it is about to mint — it is the one thing on that screen a
person cannot later fix by typing over it.

Only a **couple-added** option is renamable. Overriding the pack's copy is a
different mechanism: it forks copy a bump is still meant to improve, which is the
fork this ADR exists to avoid, in miniature.

## Who may extend a field

Gated on the field's own `set_permission`, not on a policy of its own. The type
schema already says who may put a value in a field, and adding to the list of
values you may put there is that same authority. So the words for what happened
to you are never behind your partner, and a pack type that tightens a field
tightens who may extend it with nothing to keep in step. A second answer here —
"only a dom may edit vocabulary", say — would be a second thing to keep correct,
and would have to be re-decided every time the pack adds a field.

## Considered options

- **Adopt-on-edit, mirroring ADR 0002.** Rejected above: the unit of adoption
  (the whole type) is far larger than the unit of edit (one word), which is not
  true for rules.
- **Merge at each call site.** Rejected: there are two validators, a composer, a
  queue, an engine and a label resolver, and the first one anybody forgets is a
  couple's word silently refused on one path and accepted on another — verbatim
  the failure `checkMetadataValue`'s own comment was written to prevent.
- **Let a couple author whole event types instead.** Rejected as the wrong size.
  It is a five-way discriminated union of field kinds, permission lists and
  `awaiting` entries in a form, to deliver "we call it aftercare" — and a custom
  type still would not behave as an act, because acts are acts by *being the
  `act` type*, not by a category flag.
- **Ship the words in the pack and take requests.** Rejected: the pack cannot
  know a couple's vocabulary, and every addition would be a deploy. That the pack
  already ships fourteen acts is not evidence it ships the right fourteen for
  anyone in particular.

## Consequences

- **Suppressing a pack-shipped option is out of scope**, deliberately. It needs
  its own mechanism and its own thinking about events already logged with the
  suppressed word — a question adding one never raises.
- **Label edits are retroactive.** Event types are not versioned at all, unlike
  rules (ADR 0002) or Agreement names (ADR 0009, "a rename is never
  retroactive"), so a relabel re-reads past events under the new word. The app
  already accepts this hazard from pack bumps — `seedDefaults`'s own comment
  cites the `orgasm` type's `permitted` awaiting entry reaching already-seeded
  couples — and adding a word raises it not at all. Versioning event types is a
  larger change than this one and would be the right place to fix it.
- **The mechanism is generic.** Nothing here names `act`. Any pack enum the
  couple's role may set is extensible, including ones the pack has not shipped
  yet.
- **`stopwatches-panel.tsx` had to already read its activity options from the
  type** (#182). A surface still holding a hardcoded copy of a pack enum silently
  will not show a couple-added word — which is the general hazard, and the
  general answer is that a hardcoded copy of a pack list is a defect now, not a
  shortcut.
