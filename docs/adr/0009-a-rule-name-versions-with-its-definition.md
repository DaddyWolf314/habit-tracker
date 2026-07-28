---
status: accepted
---

# A rule's name versions with its definition

The rules screen headed its editor with the rule's stable id — "Edit
custom-late-check-in" — because a rule had no human-facing name to render. #98
logged it as a copy nit. It is not one: there was nothing to fix the copy *to*.

Two cheap fixes were considered and rejected before this decision was reached.

**De-slugging the id for display** needs no schema change and reads fine on the
day a rule is written. It becomes a lie the moment a rule's id and its behaviour
diverge, and ids are stable by design (`ruleSchema = ruleDefinitionSchema.extend({
id: z.string() })`) — so the lie can never be corrected. The trace cites rule ids,
which is exactly why they cannot be re-slugged when the wording moves on.

**Using `describeRule().when`** is truthful by construction, since it is generated
from the condition. But it is a sentence, not a heading — and in the editor it
changes under the author as they edit the draft, so the thing naming the rule is
never stable long enough to be a name.

So rules get a real name. The question this ADR settles is *where it lives*.

## Decision

**`name` sits on the rule version, not on the identity row**, alongside the
condition and effects it describes. Renaming a rule appends a version like any
other edit (ADR 0002, forward-only), and every surface that shows a past moment
shows the name in force at *that* moment.

This is the same call ADR 0006 made for `agreement_versions`:

> `agreement_versions` carries `name` alongside the prose, so renaming is not
> retroactive: a citation renders what the term was called at the time.

It applies more sharply to rules, because rule history is *displayed*.
`listRuleHistory()` feeds both the revision list on the rules screen and the
change notices on Today, and ADR 0002 leans on those notices as its consent
substitute for dom-only authoring. A name on the identity row would retroactively
rewrite what a change notice the sub already read said the rule was called — a
rename would quietly edit the record of what they were told.

The read path is one function, `ruleName()`, which falls back to a de-slugged id.
That is the rejected display strategy, kept as the floor rather than the plan: a
rule can genuinely arrive with no name (a revision written before v11, a notice
about a since-purged rule, a `Rule` the engine assembled in memory), and a
de-slug is a better answer than a blank heading.

## Why the name is not part of "the same definition"

`sameDefinition()` in `rule-reconciliation.ts` gates two things: whether a pack
bump overwrites an un-adopted rule, and whether an adopted one raises the "new
default available" notice. It compares condition, effects and `enabled` — and
deliberately **not** `name`.

A rename changes nothing about what fires. Counting it would raise the
new-default notice over a reworded heading, and that notice is the one ADR 0002
relies on; training the couple to dismiss it is a real cost paid for no signal.

The consequence, stated because it is a choice and not an oversight: a pack
release that *only* renames a rule does not reach couples who already have it.
Their rule keeps the name that was in force when their version was written, which
is the same non-retroactivity the model gives their own edits, pointed at the
pack. A pack rule whose behaviour moves carries its current name along with the
new version.

## Why the migration does not name the pack's rules

v11 adds a nullable `rule_versions.name` and backfills **custom** rules only,
from a de-slugged id. Pack rows are left null, and `ensureRulePackSeeded` fills
them from `rules.json` on the version bump — a repair that appends no version,
touches no definition, and skips any revision that already carries a name, so a
couple's own rename of a pack rule survives it.

The alternative — freezing the pack's names as literal `UPDATE` statements in the
migration — was rejected because migrations are append-only and never edited.
Since a rename does not reconcile (above), those frozen strings would become the
couple's permanent names and silently diverge from the pack the first time it
reworded one.

The custom-rule backfill *is* the de-slug this ADR rejected as a display strategy,
and it is still right as a one-time seed. What it writes is an ordinary name the
couple can correct; a permanent de-slug-on-read is one they never can, because the
id it derives from is immutable.

## Considered options

- **`name` on the `rules` identity row.** Simpler — one row to write, no
  resolution on read, and a rename is a single `UPDATE`. Rejected: it makes a
  rename retroactive across the two surfaces that exist to show the past, which
  is the defect effective-dating exists to prevent, reached from the display side.
- **A separate `rule_names` history table.** Keeps the definition untouched and
  versions the name on its own clock. Rejected as a second effective-dated
  mechanism for one field: `versionInForceAt` would then have two callers per
  rule that could disagree about which moment they resolve at.
- **No name; de-slug the id everywhere.** The cheapest fix, and the one #150 was
  filed to reject. Kept as `ruleName()`'s fallback.

## Consequences

- **The pack names every rule it ships**, pinned by a test. A pack rule the couple
  never edits has no other route to a name, so a missing one would render as "R7"
  for ever with nothing to catch it.
- **The editor's name box is offered on an edit, not only on a create.** A rule
  that cannot be renamed would leave the id as the de-facto name again.
- **The id still comes from the name on create, and only on create.** Renaming
  never re-slugs the id — that would orphan every trace row citing it.
- **`RuleChangeNotice` carries a resolved `name`.** The server reads the version
  in force at the audit row's timestamp, so there is nothing to snapshot into the
  audit log and the sentence cannot be rewritten by a later rename.
- **The export carries `name`, nullable.** It is authored content and leaves with
  the couple's data; a rule nobody named exports null rather than the de-slug,
  which would claim they wrote a name they never typed.
- **The engine ignores it.** `name` rides on the definition for plumbing reasons —
  it reaches both the flat and versioned shapes without a second field — and
  nothing in evaluation, validation, or the trace reads it.
