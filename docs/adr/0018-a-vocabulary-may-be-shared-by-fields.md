---
status: accepted
---

# A vocabulary may be shared by fields, and is declared rather than inferred

The vocabulary screen listed **Activity twice**. Both cards read "Activity", both
offered `kneeling / service / wear / scene`, and the only thing between them was
a small grey line saying *on session started* and *on session ended*.

The duplicate listing was the symptom. The defect was that they really were two
lists. ADR 0014 keys a couple's added option on `(type_id, field_key)` and
`withAddedOptions` merges per field, so a word added at one card was absent from
the other — and `activity` is the one enum in the pack asked on two events:

```
add "yoga"  → session_started.activity = [... , yoga]
              session_ended.activity   = [...]        ← never reached

start yoga session  → ok, R15 opens the stopwatch
stop it             → BAD_REQUEST: activity is not an allowed option
```

`stopwatches-panel.tsx` echoes the open row's activity into the close (ADR 0004
pairing, so the ref can't miss), and `checkMetadataValue` validates that echo
against the *other* enum. So the app let a couple start a session it would then
refuse to close. It ran until the per-activity max auto-closed it, which is the
failure path §4.5 reserves for a session someone forgot about — reported here for
a session the app itself had made unstoppable.

We decided an enum field may **declare a shared vocabulary** by id. Fields
naming the same id are the same list to the couple, so a couple's addition or
rename at any one of them is written to all of them, and the vocabulary screen
renders them as one card.

```
field: { kind: "enum", vocabulary: "activity", options: [...] }

session_started.activity ─┐
                          ├─ "activity" → one card, one write, one word
session_ended.activity   ─┘
```

## Declared, never inferred

The cheap version reads the duplication off the data: same `field_key`, same
`label`, same options — group them. It fixes today's screen and is wrong as a
rule.

Identical options say only that **nobody has diverged them yet**. Two enums that
happen to agree today would become one list tomorrow, and a pack bump to one
would silently reach into the other — the pack author having said nothing about
sharing and having no way to say otherwise. Worse, the coupling would blink in
and out as the pack changed: add an option to one enum and the two screens
un-merge, with a couple's existing words stranded on whichever side of the split
they landed.

An id says the sharing is **intended**, is visible in the file where the coupling
lives, and can be searched. It also keeps the negative case explicit: a field
with no id has a vocabulary of its own, which is every other enum in the pack.

## The options still live on the field

It is tempting to promote a shared vocabulary into its own corpus — one list, in
one place, that both fields point at. Rejected, and this is the load-bearing
part of the design's small size.

The pack keeps shipping options **on the field**, exactly as before. Nothing
about the read seam changes: `withAddedOptions` still merges per field,
`checkMetadataValue` still tests `field.options`, and rule validation, the
composer, the queue, the engine and `optionLabel` are all untouched — the same
zero-per-caller-awareness property ADR 0014 bought and would have had to buy
again. A corpus would have made every reader learn a second place a word can
come from, to deliver a change only one *writer* ever needed.

Because the id changes who a write reaches and nothing else, the overlay row
stays keyed on `(type_id, field_key)`. One word becomes two rows rather than
one, which is a real cost — two rows to keep in step — and it is bounded to the
two writers that create them, both of which resolve their sites through the same
function.

## One resolver, two callers

`vocabularySites` is the only place the question "which fields share this word"
is answered. The DO fans its write across what it returns; the screen groups its
cards by the same call.

That is not tidiness. If the screen grouped by one rule and the write fanned out
by another, the page would report a word it had not actually added everywhere it
appears — verbatim the failure this ADR exists to fix, moved one layer up and
made harder to see, since the screen would look right immediately after the
write and be wrong on the next load.

## Permission is re-checked at every site

ADR 0014 gates extending a field on that field's own `set_permission`: the
authority to put a value in a field is the authority to add to the list of
values you may put there. A fan-out inheriting the authority of whichever field
the caller happened to *name* would turn a shared id into a way to reach a field
you may not set — a sub adding a word to a dom-set enum by naming its sub-set
twin.

So each site is re-gated independently, and a site the caller may not extend is
**dropped rather than fatal**. The word still lands everywhere they may say it,
and the screen applies the same filter, so a card never claims a reach its write
will not have. The two session fields carry identical permissions today; nothing
in this design depends on that staying true.

## Considered options

- **Group by identical shape on the screen only.** Rejected above: inferred
  coupling that blinks in and out with pack edits, and it leaves the *server*
  splitting the list, so any other client re-creates the bug.
- **Key the overlay row on the vocabulary instead.** One word genuinely one row,
  with nothing to keep in step — the honest data shape. Rejected as the larger
  change for the smaller gain: it costs a migration on `event_type_options` and
  a second addressing mode through the read seam, to remove a duplicate row that
  one function already writes and one function already updates. Worth revisiting
  if a third field ever joins a vocabulary.
- **Drop `activity` from `session_ended` entirely.** Genuinely attractive: the
  close never *chooses* an activity, it echoes the open, and a duplicated fact
  that can contradict its own opening event is the untruthful shape. Rejected
  here as a different question — R16's `route_when` reads the closing event's
  metadata, and `routeGateMet` sees only `ctx.metadata`, so it would need the
  engine to route off the matched timer's tag. That is a change to how effects
  read state, argued on its own merits; it would also leave the general defect
  (two fields, one vocabulary, silent divergence) latent for the next pack
  addition.
- **Ship the two enums and pin them equal with a test.** Rejected: it keeps the
  *pack's* copies in step and does nothing about the couple's, which is the half
  that broke. The test is worth having anyway and is in `rules.pack.test.ts` —
  the pack's own options are kept in step only by that test, since the fan-out
  covers additions alone.

## Consequences

- **A vocabulary of one site is meaningless** and is refused by a pack test — an
  id that reads as though a second site exists, with nowhere to fan to.
- **The pack's copies are the pack's problem.** Two fields declaring one
  vocabulary but shipping different options would be a divergence no runtime
  code looks for; `withAddedOptions` merges per field and would carry it
  straight through. Pinned by a test rather than enforced at the read seam,
  because collapsing them at read would quietly pick a winner between two things
  a human wrote differently on purpose or by mistake, and neither is safe to
  guess.
- **Renaming from either site moves the label at both**, which is the same claim
  the token makes: one word reads one way. A site with no overlay row is a no-op
  rather than an error — the graceful-degradation call ADR 0014 already makes
  for an overlay that outlives its field.
- **The subtitle now names every event a list is spoken on** ("on session started
  and session ended"). Collapsing two cards must not drop where the second one
  was asked.
- **Declaring a vocabulary repairs the split it names.** A couple who added an
  activity under the old pack holds one overlay row, and the fan-out only helps
  the next word they type — their existing one is still unusable at the close.
  So `seedDefaults` spreads every stored word across its vocabulary's sites,
  after upserting the definitions that declare them, and the repair rides the
  same wake that installs the fix (`event-types.json` version 14 → 15).

  A blind upsert with no version of its own, matching the seeding around it: it
  re-runs on every future bump, is idempotent, and is a no-op for a couple who
  added nothing to a shared list. That is the cheap end of the trade ADR 0010's
  session settled — machinery is priced against whether the data exists — and
  here it is cheap enough not to need the answer.
