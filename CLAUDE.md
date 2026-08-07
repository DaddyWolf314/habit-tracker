# habit-tracker

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`gh` CLI) for `DaddyWolf314/habit-tracker`. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## UI conventions

### Tap targets

This is a phone-first app. Interactive controls are sized as tap targets first and
type scale second (#147). `h-11` (44px) is the floor for anything that carries a
primary action:

- `Button` — `default` is `h-11`; `sm` (`h-10`) and `xs` (`h-9`) exist for dense
  secondary rows and deliberately sit under the floor. Reach for them when a row
  genuinely cannot spare the height, not by default.
- `Input` and `SelectTrigger` — `h-11`, so a field and the button beside it line
  up by construction.
- Bare `<select>` — import `fieldClass` from `#/components/ui/field.ts`. Do not
  re-declare it locally; it was copy-pasted into eight screens before #147, which
  is what let the floor rot in the first place.

Size new controls against these rather than re-deriving a height per component.

### Page width

Phone-first is the starting point, not the whole layout. A surface opens with one
of the three shells from `#/components/ui/page.ts` — never a hand-rolled
`mx-auto max-w-2xl p-6`, which is what seventeen screens had before and is why
the app had seventeen widths instead of one:

- `pageClass` — prose. The measure is fixed; only the padding opens up.
- `pageRowsClass` — lists of rows (the Log, rules, rewards, devices). `lg:max-w-4xl`.
- `pageColumnsClass` — surfaces that break into columns at `lg` (Today, Settings,
  Agreements, vocabulary). `lg:max-w-6xl`, and only ever with a `columnsClass` or
  `grid` child — 6xl of single-column text is the case the first bullet avoids.

Extra width above `lg` is spent on **columns, not on longer lines**. `columnsClass`
is the two-column flow for a stack of independent panels; it keeps one flat DOM
order, so the phone layout and the argued-for panel order are unchanged.

`lg` (1024px) is the breakpoint that matters: it is where `TabBar` stops being a
bottom bar and becomes a side rail, and where the root layout becomes a flex row.
The rail is one restyled markup tree, not a second copy — keep it that way, so one
tab stays one link in the accessibility tree.
