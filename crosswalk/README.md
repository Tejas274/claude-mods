# crosswalk 🚸

warns you when claude is about to edit a file that someone else's open pull request also changes. it never blocks the edit, it just tells you so you can look before you collide.

install (inside claude code):

```
/plugin install crosswalk --marketplace Tejas274/claude-mods
```

say `y`, pick user scope, restart. or from the terminal: `claude plugin marketplace add Tejas274/claude-mods && claude plugin install crosswalk@claude-mods --scope user`

needs the [GitHub CLI](https://cli.github.com/) (`gh`) installed and logged in (`gh auth login`).

### how it works

when claude edits, writes or changes a notebook in a file that's in an open PR, a line shows above the prompt for 10 minutes:

```
🚸 crosswalk · app.ts is in PR #14 'Fix login redirect' by alice · updated 2h ago (+1 more)
```

and a toast pops up once per file and PR.

the line sits on top of whatever else draws above the prompt, as long as crosswalk runs above the other band mods. a band mod that draws its own band without passing the rest through (usage-radar does this for now) hides the line, so in that case you only get the one-time toast.

`/crosswalk` lists every file your branch changes (commits since the base branch plus uncommitted changes) that an open PR also changes:

```
crosswalk: 2 files on this branch are also in open PRs (12 open PRs checked, read 3m ago):
lib/auth.ts — #22 (bob)
src/app.ts — #14 (alice), #22 (bob)
```

skipped: the PR for the branch you're on (including a fork's PR you checked out with `gh pr checkout`; switching branches counts right away in `/crosswalk` and within a minute in the band), and PRs you opened yourself (unless `includeMine` is on). files in submodules are skipped too. bot PRs show as `app/dependabot` and the like.

### when it reads GitHub

it runs `gh pr list` (up to 100 open PRs, the first 100 files of each) for the repo you're in, every 5 minutes, only while a Claude Code window is open and you've done something in the last 30 minutes. if gh fails or GitHub rate limits you, it waits 2, 4, 8, then 15 minutes before trying again, and other sessions wait with it.

it's off (quietly) in a folder that isn't a git repo, a repo with more than one remote (like a fork with `origin` and `upstream`), a remote that isn't github.com, or when `gh` isn't installed or logged in. `/crosswalk` says which.

### options

in `/config` (or `pluginConfigs` in settings.json):

- `showTitles` (on): show the PR title in the band and the toast
- `showAuthors` (on): show who opened the PR in the band, the toast and `/crosswalk`
- `includeMine` (off): also warn about PRs you opened

### privacy and safety

PR titles, branch names and logins come from other people, so crosswalk treats them as untrusted:

- the `/crosswalk` reply (which claude reads) has only PR numbers, file paths and logins, never titles or branch names. titles only go in the band and the toast, which claude doesn't see.
- titles are cleaned before they're drawn: no terminal escape codes, links, invisible or right-to-left characters, cut to one short line.
- it never changes or blocks an edit, and never adds anything to claude's context.
- git and gh run without a shell, with prompts off and a 20 second timeout.
- nothing about your PRs is saved. the only thing stored is a back-off timer per repo, under a hashed key.
- it doesn't read your GitHub token or gh config; gh does its own login.

to hack on it: `claude --plugin-dir ./crosswalk`, code is in `hooks/register.tsx`, tests with `claude plugin test crosswalk`.

MIT
