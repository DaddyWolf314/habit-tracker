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
