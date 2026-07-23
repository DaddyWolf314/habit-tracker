# Subject-role qualifiers instead of a state-predicate engine or per-side event types

Dom-side tracking (a Dom orgasm feeding "sub waits for the Dom") exposed that
`subject` — who an event is about — was invisible to the rules engine: every
`orgasm` event fired the sub-focused pack rules regardless of subject, so a
Dom-logged orgasm would earn demerits and sit in the adjudication queue awaiting
the Dom's ruling on themselves. We decided to make the existing subject axis
rule-visible with a **subject-role qualifier** (`subject_role = dom|sub|switch`,
resolved against the couple's member roles at evaluation time) on rule
conditions and on `awaiting` entries, rather than either alternative:

- **Per-side event types** (`dom_orgasm`): no engine change, but it forks the
  event history by type, denies that `subject` already means aboutness, and
  leaves the latent mis-fire bug in place.
- **State predicates** ("fire only if the Dom hasn't come since X"): protocols
  like "sub cums only after the Dom" are *human agreements* adjudicated by the
  Dom with projected evidence (`since_dom_last_orgasm`), not engine automation.
  The condition language stays equality-only; state queries remain the flagged
  v2 extension.

Subject-role equality is the same complexity class as the metadata equality the
engine already has — it extends the condition language without breaching the
"rules route values, never compute them" line.

## Consequences

- Pack rules R10–R14 gain new effective-dated versions adding
  `subject_role: sub`; forward-only as always. Couples who adopted (edited)
  those rules keep their frozen definitions and get only the upstream-changed
  notice.
- In a **switch/switch couple**, `dom`/`sub` qualifiers match nothing — the
  pack's orgasm rules go dormant by design. If this bites, generalize the
  qualifier (e.g. relative or member-scoped forms) rather than reverting to
  per-side types.
- `log_permission` deliberately stays per-type (no subject qualifier) until a
  real couple needs per-subject granularity; the qualifier pattern extends to
  it naturally.
- **No creation-time rejection of "impossible" subject clauses.** The original
  plan ("validation rejects a subject clause on a type that cannot carry that
  subject", #74/#77) turned out to be vacuous: every event type may carry a
  subject — `subject_required` governs whether one *must* be given, never
  whether one may — and the role enum is already schema-constrained. A
  qualifier that matches no member (e.g. `dom` in a switch/switch couple) is
  dormancy, which is couple state, not a schema error. Rule validation
  therefore checks nothing subject-related by design.
- Unqualified pack orgasm projections (`orgasms_lifetime`, `since_last_orgasm`,
  …) formally mean the *sub's*; ids are kept, display labels tightened.
