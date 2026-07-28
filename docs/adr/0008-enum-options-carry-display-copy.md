---
status: accepted
---

# Enum options carry display copy, and a surface may override it

`CONTEXT.md`'s **Disposition** entry states the rule plainly: "A row shows its
*display word*, never the stored one." Every enum control in the app broke it.
The dom's ruling buttons, the composer's metadata editor and the rule-condition
picker all render `field.options` directly, so they printed `exceeded`,
`wants_conversation` and `vaginal_creampie` as-is.

#154 humanized `quality` in one place — the sub's Mark-done form, where the copy
had a second job to do (a self-stated quality *resolves* the awaited key rather
than asking for a ruling, so the option text has to say which path a pick takes).
It could not fix the generic controls, because a `string[]` has nowhere to put a
display label. The result was the mismatch #155 was filed for: a sub picked "Went
beyond what was asked" and the dom ruled on `exceeded`.

We decided the **enum field carries per-option copy** (`option_labels`, a
value→label map beside `options`), every generic control and readout renders
through one resolver, and a **surface may override** the copy where its register
demands it.

## Why a parallel map rather than `[{ value, label }]`

The obvious alternative reshapes `options` into objects. Rejected: `options` is
the *validation* list — `checkMetadataValue` and `rule-validation.ts` both test
membership in it, and a rule condition stores a bare string. Reshaping it would
churn the write path and the engine to serve a display concern. A parallel map is
additive, so nothing that reads `options` changed.

The map is optional and may be partial. A couple's own event type carries no copy
and must still render, so an unlabelled option falls through to a de-slug
(`wants_conversation` → "wants conversation") and then to the token. That is the
same two-rung fallback the disposition display words already use, and it is what
lets the fix apply to *every* enum rather than only the pack's.

## Why the pack's copy is speaker-neutral

The tempting simplification is one label per value everywhere, deleting the local
map in `countdowns-panel.tsx` as redundant. We rejected it on the asymmetry #155
named: the same `quality` field is read by both partners in different voices. The
sub is claiming how they did; the dom is ruling on it. "Went beyond what was
asked" is right in the sub's own form and presumptuous in the dom's ruling
buttons; a bare verdict is the reverse.

So the pack states the option **neutrally** — "Beyond what was asked" — which is
correct wherever the app does not know who is speaking, and a surface that does
know overrides. The override stays a handful of lines in the one screen that
needs it, rather than a second copy axis in the schema. If a second surface ever
needs its own register, that is the moment to ask whether per-surface copy
belongs in the pack; one is not a pattern.

## Considered options

- **Leave the generic controls raw.** Cheapest, and honest about the cost only if
  written down — which would mean amending the **Disposition** entry to carve out
  an exception for the controls. Rejected: the entry is right, and the surface it
  exempts is the one where a person is choosing the word.
- **De-slug only (`humanize()` at the call sites).** Fixes `auto_closed`-style
  multi-word tokens app-wide for free and needs no schema change. Rejected as
  *sufficient* — `quality`'s values are already single plain words, so it leaves
  the exact mismatch #155 was filed for. Kept as the fallback rung instead, where
  it does the same work for enums nobody has written copy for.
- **One label per value, no overrides.** Rejected for the speaker asymmetry
  above.

## Consequences

- **The pack labels every option of every enum it ships**, pinned by a test.
  Partial pack copy would be indistinguishable from an oversight.
- **No migration.** Pack event types have no editing surface (`createEventType`
  only mints new ids), so `seedDefaults` upserts the new definitions on the
  version bump and every couple gets the copy. Adopt-on-edit (ADR 0002) does not
  apply, because there is nothing to adopt yet — a future event-type editor will
  have to answer that question for the whole definition, not for this field.
- **Readouts changed too, not just the controls.** The log's metadata chips and
  the queue's context chips resolve enums through the same call the controls
  make, so a picked value and a logged value can never be different words.
- **Rule prose finally does what it documented.** `rule-describe.ts` has claimed
  "an enum value shows its human option" since #64; it now has an option to show.
- **The stored value is untouched.** This is display copy over an unchanged
  vocabulary — the log, the rules and the export still carry `exceeded`.
