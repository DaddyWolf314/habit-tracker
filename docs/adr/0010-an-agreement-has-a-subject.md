---
status: accepted
---

# An Agreement has a subject, and its kind scopes authorship to it

ADR 0006 gated Agreement authorship by **role**: a kind carries an
`author_permission` role list, and `limit` seeds `[sub, switch]`. It recorded one
known hole — in a `switch` + `sub` couple the switch is the dom-side partner and
can still edit that sub's limits — and deferred it as "a model change, not a
permission tweak". #129 reopened it.

The hole is not one couple shape. `authorsKind` compares a role against a list,
and every op (`revise`, `rekind`, `retire`, `delete`) checks only that, so the
real predicate is **does this kind's author list resolve to more than one
member**. Working the seeds through the four shapes finds two live instances
pointing in opposite directions:

| Couple | `limit` `[sub, switch]` | `protocol` / `ritual` `[dom, switch]` |
| --- | --- | --- |
| dom + sub | sub only | dom only |
| dom + switch | switch only | **both** |
| switch + sub | **both** | switch only |
| switch + switch | **both** | **both** |

`limit` **over-permits**: in switch+sub *and* switch+switch either member can
move the other's boundary, which is exactly what the gate exists to prevent.
ADR 0006's table read switch+switch as benign ("limits: both", meaning each
records their own) — it is the same defect, and it means the rejected cheap fix
(take `switch` back out of `limit`) was never trading a working shape for a
broken one.

`protocol` and `ritual` **under-protect**, and this was never traced: in
dom+switch — not an exotic shape — the switch is the sub-side partner and can
revise, retire or delete the protocols that bind *them*. Not "someone moved my
boundary" but "I rewrote my own obligation".

And there is a mirror gap. `limit` excludes `dom`, so in a dom+sub couple the dom
has **nowhere to record a boundary at all**. A corpus whose stated purpose is
"anything the couple has agreed and wants recorded" structurally cannot hold half
the couple's limits.

A role list cannot fix any of this, because the thing that needs saying is about a
*member*. "No marks above the collar" is a fact about one person's body.

## Decision

**An Agreement records its subject, and its kind records how authorship relates
to that subject.**

- `agreements.subject` — a nullable member id on the identity row, the same name,
  type and nullability as `events.subject`.
- `agreement_kinds.author_scope` — one of `subject`, `counterpart`, `unscoped`.

`author_permission` stays, and **changes job**. It stops meaning "who may edit
these" and starts meaning "who may *hold* a term of this kind". `author_scope`
supplies the per-member half that a role list provably cannot express:

| Kind | `author_permission` | `author_scope` |
| --- | --- | --- |
| `protocol` | `[dom, switch]` | `counterpart` |
| `ritual` | `[dom, switch]` | `counterpart` |
| `limit` | `[dom, sub, switch]` | `subject` |
| `safeword` | `[dom, sub, switch]` | `unscoped` |

`limit` widens to all three roles. ADR 0006 already refused to scope an Agreement
to "what the sub can break" because that framing "is false of a limit"; keeping
the dom out of `limit` re-imported the same asymmetry from the other side. With
`[dom, sub, switch]` + `subject`, each mechanism does one job — the list says
*anyone may have limits*, the scope says *only yours are yours*.

`safeword` stays `unscoped`: the Agreement is the couple's written record of a
shared system, not two private ones, and pause-everything is already shared and
either-triggered.

**For the seeded kinds this asks the user nothing.** A couple has exactly two
members, so subject is derived at write time and frozen: `subject` scope → the
creator, `counterpart` scope → the other member, `unscoped` → null. There is no
"who is this about?" picker. Only a custom kind — which has no creation API today
— would ever choose a scope.

## Why one column and not two

An `author` column beside `subject` was rejected. In a two-member couple it is
derivable from the scope in every case (`subject` scope → the author *is* the
subject; `counterpart` → the author is whoever in the list is not the subject),
so storing it creates two facts that can disagree. A corpus whose purpose is
being a truthful record should not carry a field able to contradict another.

Who *moved* a term is already recorded — `recordAgreementChange` writes an
`audit_log` row carrying `actor`. That stays what it is, an accountability trail
beside the corpus, rather than becoming load-bearing for what the corpus means.

## Why the subject is stored and immutable

**Stored, not derived.** The derivation above is sound only at the present
moment: it reads the kind's current scope and the couple's current role list. A
derived subject would silently re-answer "whose term is this" for entries written
years earlier the first time a kind changed — precisely the retroactivity the
version model exists to prevent. ADR 0006 chose non-retroactive names so "a
citation renders the name in force when the act happened"; a derived subject would
reintroduce the defect one field over. A stored subject is a fact about the moment
the term was written.

**On the identity row, never versioned**, following `kind` for the same reason: a
versioned subject is an escalation path. If a revision could move it, the switch
revises the sub's limit to subject = themselves and owns it outright — the
invariant ADR 0006 closed against `rekind` and `edit_kind`, reopened through the
version table.

**Validated at creation**, because immutability without validation manufactures a
bricked entry. Under `counterpart` scope, a dom who set subject = themselves would
be excluded by the scope, leaving nobody able to author it — and `revise`,
`retire` and `delete` are all author-gated, so the entry would be permanently in
force, unrevisable and unretirable. Under `subject` scope the subject *is* the
creator; under `counterpart` it must not be.

## Why `author_scope` cannot be edited

`edit_kind` accepts `author_permission` only, and `author_scope` is set with the
kind and never changes.

Walking the escalation surface, changing a scope is the *only* remaining attack.
Widening a role list cannot escalate any more: under `subject` scope it only
widens who may hold a term, and under `counterpart` scope adding the subject's own
role changes nothing, since the scope excludes the subject by construction. This
is a real improvement — ADR 0006's guard ("editing a kind's `author_permission`
requires already being in it") stops being load-bearing. Flipping `limit` from
`subject` to `unscoped`, by contrast, converts every existing limit into a mutually
editable term in one write.

**Tightening-only was considered and fails.** `unscoped` → `subject` looks like a
narrowing, but `unscoped` entries carry no subject, so the moment the scope flips
every entry has no author and is bricked as above. The narrowing direction is the
dangerous one, so there is no exception. A mis-set custom kind is repaired by
creating a new kind and moving entries across.

## What `rekind` becomes

`rekind` requires scope-aware authorship of **both** the source and the target
kind. To move a partner's limit anywhere you would need authorship of it under
`subject` scope, which you do not have. The only reachable moves are
self-downgrades by the subject themselves — moving my own limit into `safeword`
where you can edit it too — which is mine to make and lands in the audit log.

Two paths fall out, stated here because each will otherwise read as a bug to
whoever hits the error:

- **`unscoped` → `subject` is blocked.** The entry has no subject, and inventing
  one at rekind time is retroactively deciding whose term it was.
- **`subject` → `counterpart` is unreachable by anyone.** The subject cannot
  author it under the target scope; the counterpart cannot move it under the
  source scope. Nobody can convert a boundary into an obligation, which is
  correct rather than a gap.

## The pack must stop clobbering kinds first

`seedAgreementKinds` upserts unconditionally —
`ON CONFLICT(id) DO UPDATE SET label = …, author_permission = …` — and
`agreement_kinds` carries no `adopted` or `upstream_changed`. So a couple who
tightens `limit` to `[sub]` by hand, the only workaround available before this
ADR, has that tightening **silently reset by the next kinds ship**: a permission
regression delivered as an upgrade, on the one setting whose whole job is safety.

This is a precondition, not a related cleanup. `author_scope` may only be
tightened, and an unconditional pack upsert *is* the forbidden flip performed by
the pack. Shipping a scope onto a clobberable table would make the invariant
decoration again — the failure ADR 0006 named: "without both halves the safety
property is policy, not structure."

So `agreement_kinds` gains `adopted` and `upstream_changed` and the pack skips an
edited kind and flags it, porting the discipline `rules` already has. It lands
**before** the scope column, never after.

## Build the mechanisms, skip the archaeology

No couple has authored an Agreement yet, so both backfills are near-empty and
neither earns machinery:

- `subject` backfills from `agreement_create` audit rows — exact for who typed an
  entry, cheap enough to keep. Nothing prunes `audit_log`, so the derivation is
  complete where it applies.
- `adopted` seeds to `0` for every kind rather than scanning `consent_history` for
  past `agreement_edit_kind` entries.

An earlier draft marked a backfilled subject as *inferred* and let it be corrected
once, on the grounds that derivation is exact about who typed a term but not about
whose boundary it is — the switch typing in the sub's limits is the very thing this
ADR closes. That was rejected: the machinery would outlive its reason by years,
and "immutable except when inferred" is an exception to the invariant above that
would rot it. With no data to mis-attribute, the honest simplification is to keep
the invariant whole.

**A null subject under a `subject` or `counterpart` kind is retire-only** —
readable, citable, resolvable, retirable by the role list, never revisable. This
is needed regardless of the backfill: `safeword` is `unscoped` with a null
subject, and the blocked `rekind` path above is defined in terms of it.

## Considered options

- **Take `switch` back out of `limit`.** Restores the guarantee in switch+sub.
  Rejected: switch+switch is *also* holed today, so this trades one broken shape
  for another, and it deepens the dom-limit gap rather than closing it.
- **Special-case the pairing** — a switch authors limits only when the couple has
  no sub. Rejected: authorship would depend on who your partner is, which no other
  permission in the app does, and it reads as a bug the first time someone hits it.
- **A per-kind self-authored flag.** Entries belong to whoever created them.
  Closes `limit` in every shape and the dom-limit gap, and costs the same one
  column. Rejected because it cannot express the opposite constraint: `protocol`
  needs *anyone but* the subject to author it, and one flag cannot say both. It
  also makes the first writer the permanent owner with no record of aboutness.
- **Authorship derived from a subject, universally** (#129's option 1 as written).
  Rejected on its own counter-example: a protocol is about the sub and authored by
  the dom, so a universal rule would hand protocols to the sub. Per-kind, via
  `author_scope`, it holds — which is what this ADR does.
- **Accept it as honor-system.** The app is honor-system by design, and a switch
  who edits their sub's limits leaves an audit row. Rejected: ADR 0006 gave
  `limit` its own authorship precisely because "a limit binds the dom" and
  transparency is not the check that the terms themselves get. Accepting it here
  would mean the one kind built to be structurally protected is the one that
  isn't.
- **Defer until a real switch+sub couple appears.** Rejected: the corpus is
  merged, migration v10 has run, and the cost of the model change only rises with
  the first real entry. #129's own framing ("the corpus is unshipped; this costs
  nothing to defer") was already out of date when it was written.

## Consequences

- **Authorship becomes per-entry.** `authorsKind` survives as the *creation* gate;
  a new per-entry check takes the entry's subject and the viewer's member id and
  drives the row controls. `agreements-view.tsx` currently computes one
  `canAuthor` per kind section and passes it to every row — that is the shape this
  breaks.
- **Entries of a scoped kind carry an ownership label, and a section sub-groups by
  subject only when more than one distinct subject is present.** A dom looking at
  a limit with no edit control must be able to tell *why*: today that always means
  "your role doesn't author this kind", and afterwards it may mean "this one is
  your partner's". Leaving that to an absent button would make the new guarantee
  invisible at the only place a person would look for it. In a dom+sub couple every
  protocol is the sub's, so the grouping never appears.
- **The citing-ref picker does not filter candidates by subject.**
  `agreementsInForce` stays the candidate set: an `infraction` cites any term in
  force, and filtering to the citer's own terms would make an infraction against
  the other member's term unloggable. Subject governs who may *move* a term, never
  who may *cite* it.
- **`trackAgreement` gates on per-entry authorship**, not just the kind, plus the
  existing rule-authoring check. Under `counterpart` scope the dom tracks the
  sub's ritual, which is unchanged in substance.
- **The export carries `subject`, nullable**, and `agreement_kinds` export rows
  carry `author_scope`. Both are the couple's own data and leave with it.
- **The kinds pack goes to v2**, carrying the scopes and the widened `limit`. It
  reaches only kinds no couple has edited, per the adoption discipline above.
- **A dom can hold a limit, and the corpus surface says so.** This is a product
  change, not only a permission fix: a couple who read "Limits" as "the boundaries
  I set on my dom" will now see their dom's entries in the same section.
- **`author_scope` is immutable, so a custom kind is a permanent commitment made
  when a couple is least informed about it.** The repair path — new kind, move
  compatible entries, retire the rest — is manual, and for an `unscoped` kind they
  later want as `subject` it means re-authoring each term. That is the price of
  having no bricking path.
- **This supersedes ADR 0006's authorship-by-role decision** and the "known
  consequence" it recorded. ADR 0006's reasoning was sound given what it knew;
  the record should show the hole was found and closed, not that it never existed.
- **CONTEXT.md's Agreement kind entry loses "authorship is by role, not by member"
  and "a plain dom never authors limits"**, and gains **Author scope**.
