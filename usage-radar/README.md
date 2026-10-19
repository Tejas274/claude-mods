# usage-radar

I kept running out of context (and hitting the 5-hour limit) without seeing it coming, so I built this. It sits above the prompt and shows what's going on while Claude works.

![band](docs/band.png)

## Install

```
/plugin install usage-radar --marketplace Tejas274/claude-mods
```

Pick **user** scope, restart Claude Code. Or: `claude plugin marketplace add Tejas274/claude-mods && claude plugin install usage-radar@claude-mods --scope user`

## What it shows

Above the prompt: model, tokens, cost, elapsed time, what Claude is doing right now, and meters for context and (if your plan reports them) the 5-hour and weekly limits.

A toast when any meter crosses 80% and again at 95%, once each. For context it'll nudge you to `/compact`.

The status line gets a one-line version with whichever meter is closest to full.

`/radar` opens a panel with the job's cost, tokens and time, the limits with reset times, and one row per agent. It opens by itself when Claude starts a helper agent. On a wide terminal it docks on the right.

![panel](docs/agents-panel.png)

## Notes on the numbers

- Context and limits come straight from Claude Code (same numbers as its own status line). On some accounts, Enterprise for example, the 5h/weekly limits aren't reported, so you'll only see context.
- The job cost is real (same as `/cost`). The per-agent split is an estimate, hence the ≈.
- The timer runs until the main agent *and* every helper are done.

It only reads Claude Code's own session data and doesn't send anything anywhere.

## Hacking on it

```bash
claude --plugin-dir ./usage-radar
claude plugin test usage-radar
```

Everything is in `hooks/register.tsx`.

## Changelog

- 2.0.0: renamed from savvy-progress; context and plan-limit meters with alerts
- 1.2.0: panel grows to fit all agents
- 1.1.0: timer waits for background helpers; new colours
- 1.0.0: first version

MIT
