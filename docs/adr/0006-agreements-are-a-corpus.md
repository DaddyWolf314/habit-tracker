---
status: accepted
---

# Relationship agreements are a first-class corpus, distinct from engine rules

The app shipped two things called "rule": the engine primitive (`when type = X
[AND metadata equality] → effects`, which owns a nav tab and 1,846 occurrences
across 69 files) and the couple's behavioural agreement that an `infraction`
cites through `rule_ref` — free text naming nothing the app held a row for. The
glossary already forbade conflating them; the product did it anyway, asking a sub
logging an infraction for a "Rule" while "Rules" in the nav meant automation.

We decided the human side becomes a first-class corpus — an **Agreement** — and
that the engine keeps the word **Rule**, moving off the nav into Settings.
**Protocol** narrows from the name of the concept to the name of one Agreement
kind.

## What an Agreement is

An Agreement is anything the couple has agreed and wants recorded: a standing
expectation, a recurring practice, a limit, a safeword. It is **not** scoped to
"what the sub can break" — that framing is false of a limit, which binds the dom.

- **Kinds are per-couple definitions**, shaped like event types, each carrying an
  `author_permission` role list. The pack seeds `protocol`, `ritual`, `limit` and
  `safeword`; couples may add their own. Authorship therefore follows the kind:
  the dom writes protocols and rituals with the sub notified (ADR 0002 parity),
  the **sub side alone** writes limits, safewords are either-authored. A `switch`
  authors both sides, limits included: they hold both halves of the dynamic, and
  a `sub`-only limit kind would leave a switch/switch couple unable to record a
  boundary at all — ADR 0003's dormancy is right for rules, whose scoring simply
  stops, and wrong for the kind that exists to record a boundary.

  Authorship is therefore **by role, not by member**, and that has a known hole:
  in a `switch` + `sub` couple the switch is the dom-side partner and can still
  edit that sub's limits. Closing it means scoping a limit to the member it
  protects rather than to a role — a model change, not a permission tweak — so it
  is recorded rather than patched around.
- **You cannot grant yourself authorship you do not hold.** Editing a kind's
  `author_permission` requires already being in it, and an Agreement's `kind` may
  only be set to one you author. Without both halves the safety property is
  policy, not structure: the dom would simply edit `limit`'s author list, or
  re-kind a `protocol` into a `limit`, and be authoring in the sub's category.
- **Versions carry name and prose together**; `kind` sits on the identity row and
  never versions (a versioned kind is the escalation path above). Renaming is
  therefore not retroactive — a citation renders the name in force when the act
  happened, and surfaces disambiguate as "morning kneel *(now: dawn ritual)*".
- **In force or retired, plus future-dating.** There is no draft state: a version
  with a future `effective_from` is the announced draft, and it is announced on
  purpose — a private drafting space the other partner cannot see is the one
  thing a consent-first corpus should not have. Retiring is effective-dated and
  keeps every version readable. Following ADR 0002's "delete collapses to
  disable", a hard delete is allowed only for an Agreement nothing has ever cited.

## The corpus is wholly shared, and starts empty

**Every Agreement is shared.** The journaling visibility axis does not extend
here: a limit the dom cannot read cannot be respected, and a term the sub cannot
read is a secret rule they are bound by. This makes the corpus the one place in
the app with no privacy gradient at all, deliberately — a term binds two people,
so both must be able to read it. What a gradient would have served is already
served elsewhere: private boundary-work is a `secret` **journal entry**, promoted
to a limit when its author is ready, and "I need to talk but can't say why yet" is
R18's `check_in` with `flag=wants_conversation`. A sealed limit would be a second,
weaker version of that signal, protecting nothing while looking like protection.

**No Agreements ship.** Kinds are mechanism and seed with the pack; entries are
the couple's own terms, and a default term is one nobody consented to but everyone
has. `bootstrap.md:97` does plan an editorially-controlled library including
"protocol templates" — that arrives with #49's template editorial pipeline, as a
library the couple *pulls from*, never defaults they are given. Until then the
corpus starts empty and onboarding carries the blank first run.

**Review nudges never lapse an Agreement.** `bootstrap.md:89` reserves a schedule
slot for "agreement-renewal nudges"; an Agreement may carry an optional review
cadence, and when it fires both members get an in-app notice prompting a
conversation. The term stays in force whether or not anyone answers. Auto-retiring
an unrenewed Agreement was rejected: a countdown expiring is the point of a
deadline, but a protocol lapsing removes a term neither partner removed, and this
app already has an explicit authored way to make everything stop (pause-everything).
The mechanical layer supplies the evidence; the humans supply the judgment.

## Citing refs — a third ref flavor

ADR 0005 split refs in two: an **originating** ref mints an id, an **echoing** ref
repeats one to pair with it. An Agreement ref is neither. No event mints it (the
definition exists first), and its candidates are not open timers but the
Agreements in force — a retired Agreement stops being offered for *new* citations
while every past citation of it must still resolve and every rule matching it must
still fire on replay. That is the opposite candidate lifecycle from an echoing
ref, whose resolved timer "is never a candidate".

So `citing` joins the taxonomy rather than stretching `echoing` until the
Ref-candidate definition becomes false.

## Two resolution clocks, deliberately

**An Agreement citation resolves to the version in force at the event's
`occurred_at`** — not its log-time. This diverges from ADR 0002, where a rule
version resolves at log-time, and the divergence is the point:

- A **Rule** version governs *when the machine acted*. The effect genuinely
  happened at append time.
- An **Agreement** version governs *what the person was bound by*, which is a
  fact about the moment of the act, not of the paperwork.

Backfill is expected in this app ("`occurred_at` and `logged_at` are separate on
purpose… time-anchored effects use `occurred_at`"), so log-time resolution would
convict a sub under terms written after they acted — the same defect ADR 0002
exists to prevent, displaced from scoring onto the terms themselves.

The cost is that `occurred_at` is author-supplied, so citations are backdate-able.
Accepted: `severity` is dom-adjudicated and the queue card shows both timestamps,
so a convenient backdate is visible to the person ruling on it.

## Agreements scaffold Rules; they do not own them

A trackable Agreement can **generate** the counter/streak/rule recipe once, after
which the artifacts are ordinary Rules and counters with ordinary versioning,
audit rows, partner notices and editability. Nothing stays linked.

The alternative — automation living *on* the Agreement — was rejected because the
two resolution clocks above make it incoherent: one edit to an Agreement carrying
its own target would land in two different pasts at once, `occurred_at` for the
terms and log-time for everything the engine did with them.

## The corpus surface is a reference document, not a checklist

Handoff §1 promises the "sub sees a **protocol checklist**". We are not building
one, deliberately. You do not tick a limit, and you do not tick "ask before you
come" — a standing term is satisfied by the *absence* of an event. The only
tickable kind is `ritual`, and ticking one means logging a `ritual_completed`
event, which the Log composer already owns.

The daily slice a sub actually needs — what is expected of me today — emerges on
**Today** instead, as a consequence of work already scoped: #88 adds today's
counter targets, and a tracked ritual Agreement scaffolds exactly those counters.
Building a checklist on the corpus tab as well would give the couple two places to
tick the same thing.

Both roles get the same screen with authoring gated per kind, following the
codebase's existing expression of role-asymmetry (`QueuePanel` hides for the sub,
`CountdownsPanel` takes a `selfRole`) rather than introducing its first divergent
screen pair.

## Considered options

- **Swap the words: humans get "rule", the engine becomes "automation".** Best fit
  to how a couple actually speaks. Rejected on cost once the engine editor moved
  to Settings — 1,846 occurrences across 69 files, persisted `rule.`-prefixed
  `audit_log` actions needing a dual-reading decoder, the reserved `R#` namespace,
  the API routes and ADR 0002's title, in exchange for a word no longer in the nav.
- **Widen "Protocol" to cover the corpus.** Smallest glossary diff, and the term
  was already there. Rejected because its own definition — "the sub is held to and
  can break" — is false of a limit and a safeword, so widening it would have meant
  keeping the word and discarding its meaning.
- **Leave the human side unstructured.** Status quo. Rejected: it is the footgun
  #114 named, where two independently hand-typed strings must agree forever or a
  rule silently stops firing.
- **Rename `rule_ref` to `agreement_ref`.** Rejected in favour of ADR 0005's
  precedent — `task_id` kept its name while its semantics changed. Renaming
  orphans historical metadata *and* silently breaks stored rule conditions keyed
  on the old name, for a key no user ever sees (every surface renders
  `label ?? key`).

## Consequences

- **`infraction.rule_ref` and `ritual_completed.ritual_id` keep their key names**;
  their `ref_kind` becomes `agreement`, their flavor becomes citing, and
  `rule_ref`'s label stops saying "Rule". `rule_ref` survives in exports forever as
  an internal identifier.
- **Citations already in a log can never be back-filled.** Events are never
  mutated, `compositeMetadata` folds only adjudications, and an adjudication may
  only touch keys carrying an `adjudicated_by` grant — which neither key has. Old
  free-text citations stay free text, exactly as ADR 0005 accepted for `task_id`.
- **This supersedes #114.** Its option 2 ("a Ritual becomes a definition") arrives
  as the `ritual` kind; its hand-typed-string failure closes via the citing-ref
  picker plus scaffolding.
- **A dom-subject `infraction` becomes recorded but inert.** `severity` gains a
  subject qualifier so such an event is never pending, and R6/R8/R9 gain
  `subject_role: sub`. This fixes a live defect — those three rules carry no
  qualifier today, so a dom-subject infraction currently increments the *sub's*
  `infractions_lifetime` and `demerits`. It is a pack change, so per ADR 0002
  couples who have already edited R8 stay frozen on the buggy version and receive
  only the upstream-changed notice.
- **The engine rule editor moves into Settings**, where handoff §9 always had it,
  and the freed tab goes to Agreements. The rule-change notice detaches from that
  screen and surfaces on Today, because ADR 0002 rests on it: transparency is what
  stands in for a mutual-consent handshake, and it cannot do that two taps deep
  behind a gear icon.
- **`consent_history` gains real entries beyond role confirmation** — the table
  has described itself as the place "later agreements append" since Phase 1. Both
  Agreement edits and review-nudge reaffirmations write there.
- **The blank first run is onboarding's problem**, created on purpose by shipping
  no seeded entries. Nothing in the app explains the corpus by example until #49's
  template library exists.
