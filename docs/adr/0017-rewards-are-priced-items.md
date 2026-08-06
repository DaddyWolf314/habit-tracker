---
status: accepted
---

# Rewards are priced items, redeemed by an adjudicated event

ADR 0015 makes a consequence ladder work by surfacing a **crossing**: pass a rung
and the app announces it. Mirroring that for rewards would mean a positive counter
whose rungs announce a reward on the way past — and it would make saving up
impossible, because the small reward fires at 20 while the sub is banking toward
the big one at 100.

So the reward side is not a mirror. A rung *announces at a threshold*; a reward is
**chosen** and **priced**. That single difference is what this ADR is about, and
everything else follows from it.

## A reward item is a definition, not a rung

A first-class, append-only versioned definition holding the currency counter, the
price, and the terms. It was tempting to put prices on the counter beside the rungs
— one place for every number about a currency — and that was declined because a
store is a *catalogue*, not a property of a tally: items are added, retired, and
repriced independently of each other, and #172's library work will want them
portable, which a field on a counter definition is not.

Multi-currency falls out without a decision. Each score dimension is already its
own counter (ADR 0015), and an item names the currency it costs, so `service_points`
are saved and spent as `service_points`.

### Its clock is already fixed

The redemption event names the item, which makes `reward_ref` a **citing ref** —
a ref naming a *definition* rather than an id minted by an event, exactly as an
`infraction`'s `rule_ref` names an Agreement. CONTEXT already settles what that
implies: a citing ref "resolves to the version in force at the event's
`occurred_at`".

No fourth clock appears. A reward item resolves on the Agreement clock, because
what it is, is a term.

## Saving up is a trust property, so repricing announces itself

A sub banking 80 points toward a 50-point item is relying on the price holding. If
the dom can quietly reprice to 100, the store is theatre and the currency means
nothing.

The substrate already has the shape that prevents the *quietly* part: rule changes
and Agreement changes both raise the partner's notification count and land in
consent history. A reward item is versioned the same way and gets the same
treatment — repricing or retiring appends a version, raises the count, and appears
in consent history. Past redemptions keep the price they paid; future ones pay the
new price.

The stronger protection — honouring the old price for anyone already above it — was
declined. It needs a per-member entitled price, which is real per-member state
nothing else in the app has, and it would make the price a function of who is
asking. Announcing the change is enough: the sub can always see that the goalposts
moved, and can say so.

An item carries a **subject** and a `counterpart` author scope, inheriting ADR
0010: it is about the sub, and it is authored by the dom. Aboutness and authorship
stay independent axes here as everywhere else.

## The price is stamped on the redemption event

A rule cannot read a price off a definition. That would be computing a value, and
rules route values. So the redemption event carries the price it was quoted, and
the decrement routes it with the `by_from` ADR 0015 added.

The server stamps it from the item version in force; a client may never supply it,
under the same discipline ADR 0005 applies to a minted ref. And it is the honest
shape independently of the mechanism: raise the price next month and last month's
redemption still says what it actually cost, in the event itself, where a rebuild
will find it.

This makes `by_from` load-bearing rather than a convenience — the reward path has
no other way to move a per-item amount.

## Redemption is an event, granted per item

An item declares whether spending it needs a grant, defaulting to **yes**.

A granted item logs a redemption awaiting `granted`, adjudicated by the dom. The
points leave the counter only when the ruling lands, which means the spend rides
the `unset → set` transition — the one transition #184 identified as always safe,
because nothing fired for a blank and there is nothing to reverse. A refusal costs
the sub nothing, and the request sits in the queue that already exists, with the
time-in-queue pressure it already applies.

A self-serve item decrements at append.

Both paths existed already; the item only says which kind of thing it is. Forcing
one shape would have been false to half the cases: "an hour of your undivided
attention" cannot be self-serve because the dom has to turn up, and "skip today's
ritual" needs no ceremony. A model supporting only one of those is wrong about the
other.

## Consequences

- A new versioned definition kind: identity row plus append-only versions, the
  fourth instance of the shape in ADR 0013's table, resolving on the `occurred_at`
  clock rather than a new one.
- `refs.ts` gains a `reward` citing-ref kind, and `ref-candidates.ts` gains its
  candidate rule: the items in force, matching the Agreement rule that a retired
  entry is offered for no new citation while every past citation still resolves.
- The pack ships **no default reward items**, for ADR 0015's reason: what a couple
  offers and what it costs is theirs to agree.
- A store surface is needed on the sub's side, and it must show what is affordable
  without becoming a second pressure surface. The affordability signal is a price
  crossing (ADR 0015), so it is already a notification source and needs no separate
  mechanism.
- `notifications.ts` gains reward-item changes alongside the rule and Agreement
  changes it already composes.
- A redemption cannot be retracted after it is granted — retraction is allowed only
  while an event is pending, which here means only before the grant, which is also
  the only window in which nothing has been spent.
- Nothing stops a couple pricing an item in a counter that resets weekly. It will
  behave exactly as it reads: savings evaporate at rollover. This is not guarded,
  because a `reset` cadence is the couple's to set and a use-it-or-lose-it
  allowance is a legitimate thing to want.
