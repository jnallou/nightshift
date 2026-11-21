# Nightshift

Happy birthday. This is an engineer that works while you sleep.

Every night Nightshift clocks in, reads what your users ran into, finds the cause in your code, and leaves pull requests for you to review in the morning. It never merges anything. You stay the boss.

```
   listen            remember            think             fix               you
 reviews, crashes   what it already    group, rank,     one branch per     review, merge
 feedback, logs  -> opened and what -> find the code -> problem, checks -> or close with
 metrics, issues    you said about it  decide            run, open a PR     a comment
        ^                                                                      |
        +------------------- your verdict is the next lesson ------------------+
```

## Install

In your app's repository:

```bash
npx github:jnallou/nightshift init
```

It looks at your project, works out the stack, finds your app on the App Store from the bundle id, and writes three things: `.nightshift/` (settings, plus its own code so you can read and change all of it), a GitHub Actions workflow, and one line in `.gitignore`. Then it prints the last three steps, which take about two minutes:

1. Give it a Claude credential as a repository secret (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`).
2. Allow GitHub Actions to open pull requests.
3. Commit, push, and start the first shift with `gh workflow run nightshift.yml`.

## What it listens to

Set these in `.nightshift/config.json`.

| Source | What it brings | What it needs |
| --- | --- | --- |
| App Store reviews | Unhappy reviews, with the app version | Nothing. On by default |
| App Store Connect | Reviews, TestFlight feedback and crash logs, hangs, slow launches, performance regressions | An App Store Connect API key in the secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` |
| Sentry | Top unresolved errors with stack traces and user counts | `SENTRY_AUTH_TOKEN`, plus `org` and `project` in the config |
| GitHub issues | Issues labeled `bug` or `feedback` | Nothing. On by default |
| Inbox | Any file you drop in `.nightshift/inbox/`: a pasted email, exported logs, a JSON list | Nothing. On by default |
| Your own commands | Anything a command can print: backend logs, analytics queries | A line in the config |

A command source looks like this. Print JSON or plain text, either works.

```json
"commands": [
  { "name": "backend-errors", "run": "gcloud logging read 'severity>=ERROR' --freshness=1d --format=json --limit=50" }
]
```

If your bug reports arrive by email, `extras/support-inbox-to-issues.gs` is a small Google Apps Script that turns them into `feedback` issues.

## How it learns

There is no database. GitHub is the memory.

- **Merge** a pull request and it knows that kind of fix is welcome. If the same problem shows up again after the fix shipped, it tells you the fix did not hold.
- **Close** one with a comment saying why, and it reads that comment on every later shift. It will not raise that problem again.
- **Write** standing instructions in `.nightshift/notes.md`: areas to leave alone, how you like changes made, what matters most this month.

## What it will not do

- Merge, or push to your main branch. Every change is a pull request with you as the reviewer.
- Touch workflows, secrets, signing files or its own settings. A change that does is thrown away and you get an issue instead.
- Open a pull request when its checks fail. It tries once more, then writes up what it found.
- Guess. When it cannot find the cause, it opens an issue with the diagnosis and says what evidence would settle it.
- Flood you. Two pull requests and three issues per night by default.
- Build features on its own. Requests become issues for you to decide.

Reviews and bug reports are written by strangers, so the agent treats them as evidence and never as instructions. It also runs with a short leash: it can read and edit files and run only the check commands you listed. It never sees your GitHub token or your App Store and Sentry keys, and the engine, not the agent, does every push.

One honest limit: the agent runs your check commands, and those run your code, so do not point it at a repository where you would not run CI on a stranger's pull request.

## Checks

`checks` in the config is the list of commands that prove a change is sound, such as `npx tsc --noEmit` or `npm test`. The agent runs them, and the engine runs them again itself before opening anything. Every pull request says exactly what was run.

For a Swift app the list starts empty, because building needs a macOS runner and those cost more. Until you add one, each pull request says plainly that the change was read but not compiled. To have it build, set `runs-on: macos-latest` in the workflow and add your `xcodebuild` line to `checks`.

## Try it by hand

```bash
node .nightshift/engine/bin/nightshift.mjs collect        # what it hears, no model used
node .nightshift/engine/bin/nightshift.mjs run --dry-run  # a full shift that pushes nothing
node .nightshift/engine/bin/nightshift.mjs doctor         # is everything in place
```

A dry run leaves the fix on a local branch and the pull request text in `.nightshift/run/` so you can read both.

## Cost

Each shift makes one triage call, plus one or two calls per problem it tries to fix. Quiet nights make no model calls at all. `budgetUsdPerCall` in the config caps each call, and the run summary in GitHub Actions shows what was spent.

## Development

No dependencies. Node 20 or newer.

```bash
npm test
```
