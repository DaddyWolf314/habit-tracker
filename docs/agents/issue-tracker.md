# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

How `/wayfinder`'s map, tickets, blocking, and frontier are expressed on GitHub. Both
relationships below are **native** — they render in GitHub's own UI, so the frontier is visible
without opening the map.

Both APIs take a **database id** (`.id`), not an issue number. Fetch one with
`gh api repos/{owner}/{repo}/issues/<number> --jq '.id'`.

- **The map** — an issue labelled `wayfinder:map`. Find the open ones with
  `gh issue list --label "wayfinder:map" --state open`.
- **Tickets** — issues labelled `wayfinder:<type>` (`grilling`, `research`, `prototype`,
  `task`), attached to the map as **sub-issues**:

  ```
  gh api -X POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id=<child db id>
  gh api repos/{owner}/{repo}/issues/<map>/sub_issues --jq '.[] | "\(.number)\t\(.title)\t\(.state)"'
  ```

- **Blocking** — GitHub issue **dependencies**:

  ```
  gh api -X POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker db id>
  gh api repos/{owner}/{repo}/issues/<number>/dependencies/blocked_by --jq '[.[].number]'
  ```

- **The frontier** — open, unassigned children whose every blocker is closed. There is no single
  query; list the map's sub-issues, keep the open unassigned ones, and check each one's
  `blocked_by` for a non-closed entry.
- **Claiming** — `gh issue edit <number> --add-assignee @me`, **before** any work. An open,
  unassigned ticket is unclaimed.
- **Resolving** — post the answer as a comment, then close:
  `gh issue comment <number> --body-file <file>` followed by `gh issue close <number>`. Then
  append the one-line pointer to the map's Decisions-so-far with `gh issue edit <map> --body-file`.

`gh` infers the repo from `git remote -v`, so run it inside a clone — or pass
`-R DaddyWolf314/habit-tracker` when the working directory is elsewhere (writing issue bodies to
a scratchpad file and passing `--body-file` needs this, since the scratchpad is not a git repo).
