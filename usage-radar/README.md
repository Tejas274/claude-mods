# Usage Radar

**Know how close you are to your limits, before you hit them.** Live plan limits, context fill, cost, tokens and every agent, right inside Claude Code.

![Usage Radar band above the prompt](docs/band.png)

![Usage Radar panel](docs/agents-panel.png)

## Install

Inside Claude Code:

```
/plugin install usage-radar --marketplace Tejas274/claude-mods
```

Answer `y` to add the marketplace, choose **user** scope (all your projects), and restart Claude Code.

Or from your terminal:

```bash
claude plugin marketplace add Tejas274/claude-mods && claude plugin install usage-radar@claude-mods --scope user
```

## What you get

| Where | What it shows |
|---|---|
| **Band above the prompt** | Model · tokens · cost · timer, a to-do / context bar, what Claude is doing now, and live meters: **5h limit**, **Weekly**, **Context** |
| **Alerts** | A pop-up the moment a meter crosses **80%** (⚠) and **95%** (⛔), once each, with the reset time. Context alerts suggest `/compact` |
| **Status line** | One line with the meter that's closest to full: `⠹ Sonnet 5 · 94k · ≈$0.41 · 5h limit 83% · Bash: npm test · 0:42` |
| **Radar panel** (`/radar`) | Cost, tokens and time for the job · every limit with a bar and "resets in 2h 10m" · one row per agent (main + helpers) with model, context, time and cost |
| **Done pop-up** | `✓ All done in 1:24 · 3 agents · 14 steps · ≈$0.53` when the whole job, helpers included, is finished |

The panel opens by itself when Claude starts a helper agent. On a wide window (110+ columns, fullscreen mode) it docks on the right.

## Colours

🟢 under 80% · 🟠 80–95% · 🔴 95% and over

## How the numbers work

- **Limits** (5-hour, weekly, and a gateway spend limit if you have one) and **context** come straight from Claude Code, the same figures as its own status line. Plan limits appear when you're signed in with a subscription.
- **Cost** is this job's real cost, from the same figures as `/cost`. The panel also shows the session total.
- **Per-agent cost** is an estimate (≈): the job's cost split by each agent's share of the work.
- **Time** runs from your prompt until Claude and every helper agent are done.

## Privacy

Usage Radar only reads Claude Code's own session numbers. It stores nothing outside the session and sends nothing anywhere.

## Uninstall

```
/plugin uninstall usage-radar
```

## Develop

```bash
claude --plugin-dir ./usage-radar     # run it; saving a file reloads it
claude plugin validate usage-radar    # check it loads
claude plugin test usage-radar        # run the tests
```

The code is in [`hooks/register.tsx`](hooks/register.tsx).

## Changelog

- **2.0.0**: renamed from savvy-progress; plan limits, context meter and 80% / 95% alerts
- **1.2.0**: panel sized to fit every agent
- **1.1.0**: timer covers the whole job, including background helpers; new look
- **1.0.0**: first release

## License

MIT
