---
status: accepted
---

# A conversation flag is derived from the log and closed by a response

R18 — `check_in AND flag=wants_conversation → notify partner` — has shipped since
the rule pack existed and has never had a surface. The whole of it is:

```
case "notify":
    this.writeTrace(traceNotify(cause, at, op.target));
    return;
```

A trace row and nothing else, so there is no record to query and Today has
nothing to render. Handoff §9.2 lists "R18 conversation flags" among the things
that make Today the MVP; the flag has been unbuilt because three questions had no
answers — where it lives, how long it lasts, and what ends it.

We decided the flag is **derived from the log**: a `check_in` carrying
`flag=wants_conversation` is open until the *other* member attaches a **`response`
amendment** to it. Nothing new is stored, and "we talked" becomes a recorded act
rather than a dismissed badge.

## Why the ending decides the rest

The app cannot observe a conversation happening, so resolution has to be a human
act — which rules out anything that expires on its own. A flag that lapses
quietly is the app deciding, on a timer, that someone no longer needs to talk.

Given that, the question is only *which* human act, and one already exists with
exactly the right shape. ADR 0001's `response` is "the partner's post-hoc prose
*reaction*… a **gift, not a debt** — never tracked as pending/owed, never
queued." That is R18's situation precisely: the sub flags that they want to talk,
and the dom replying **is** the resolution. Deriving from the log then follows —
if the closing act is an amendment, the open state is a fold over the log like
`pending` already is, not a row to keep in step with it.

## The ADR 0001 restriction does not reach here

`validateResponse` refuses a response on anything but a journaling entry, and the
reason it gives is specific: "it is only for journaling entries (**the visibility
axis only exists there**)". The restriction exists to guard sealed and secret
prose — a response must never confirm that a secret entry exists.

A `check_in` is not journaling-capable and is therefore always `shared`. There is
no visibility to leak, so extending `response` to it applies ADR 0001's guard
where it was aimed rather than loosening it. The rule stays: a response is legal
on `shared` content, never on `secret`.

## Considered options

- **A persisted notice, dismissed.** The `notify` effect writes a row; Today
  reads the undismissed ones. The most literal reading of "notify partner", and
  the only option where the flag is stored rather than derived. Rejected: a new
  table, endpoint and acknowledgement surface for one rule — and dismissing
  leaves no trace, so the record cannot answer whether they ever talked.
- **Derived with a time window.** Open for some days after the check-in, then
  gone. Cheapest, and nothing to clear. Rejected for what it means: "I need to
  talk" and the app quietly forgets.
- **A new amendment kind.** Honest about being a different act from a journal
  response. Rejected as a distinction without a difference — both are the
  partner's post-hoc prose reaction to something the other logged, which is the
  whole definition of `response`.

## Consequences

- **`response` broadens from journaling entries to shared content.** The
  validator's gate changes from "is this a journaling type" to "is this entry
  shared", which is what the original reasoning was actually about.
- **The flag is a fold, not a row.** Open state is derived the way `pending` is,
  so it cannot drift out of step with the log and needs no migration.
- **A response carries prose**, so the dom answers rather than acknowledging.
  "Notify partner" implied somewhere to reply; a dismissable chip never was.
- **Both members can see the flag close and why**, because the reply is in the
  log attached to what prompted it — where the consent record wants it.
- **Nothing arrives for a flag the partner never answers.** The flag stays open
  indefinitely, by design: the app does not get to decide the conversation
  happened. Whether an *un*answered flag should eventually surface differently is
  left open rather than guessed at.
- R18's `notify` effect keeps writing its trace row. The trace is still the
  record of what fired; it is simply no longer the only thing.
