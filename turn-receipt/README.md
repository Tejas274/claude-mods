# Turn Receipt 🧾

**An itemized receipt for every Claude Code job.** See where the time and money went (per agent, per tool), the slowest step, the biggest read, files changed and cache hits. Share it with one command.

```
          🧾  CLAUDE CODE RECEIPT
       #0042 · Mon Oct 19 2026 · 11:42
════════════════════════════════════════════
“add tests for the auth module”
────────────────────────────────────────────
AGENTS                         time     cost
Main · Sonnet 5                1:12   ≈$0.31
Explore auth · Sonnet 5        0:19   ≈$0.07
Review tests · Sonnet 5        0:24   ≈$0.09
────────────────────────────────────────────
TOOLS                  calls   time  ~tokens
Bash (1✗)                  4   0:41      6k
Read                      11   0:03     38k
Edit                       5   0:01      2k
Grep                       3   0:01      1k
────────────────────────────────────────────
🐢 Slowest  Bash: pytest -q             0:31
🐘 Biggest  Read: auth/crypto.py     12k tok
✏️  Files changed                          3
     tests/test_auth.py
     auth/verifier.py
     auth/config.py
♻️  Cache hit                            82%
════════════════════════════════════════════
TOTAL  1:24 · 23 steps                ≈$0.47
════════════════════════════════════════════
     Thank you for coding with Claude!
   turn-receipt · /receipt copy to share
```

## Install

Inside Claude Code:

```
/plugin install turn-receipt --marketplace Tejas274/claude-mods
```

Answer `y` to add the marketplace, choose **user** scope (all your projects), and restart Claude Code.

Or from your terminal:

```bash
claude plugin marketplace add Tejas274/claude-mods && claude plugin install turn-receipt@claude-mods --scope user
```

## Use it

| You do | You get |
|---|---|
| Send Claude any prompt | When the whole job is done (helpers included), a pop-up: `🧾 Receipt #42 · 1:24 · 23 steps · 3 agents · ≈$0.47 → /receipt` |
| `/receipt` | The full receipt in a panel |
| `/receipt copy` | The receipt as text on your clipboard, ready for Slack, a PR or a tweet |

## What's on it

- **Agents**: every agent (main + helpers) with its model, how long it worked and its share of the cost
- **Tools**: calls, total time and roughly how much text each tool fed back to Claude (~tokens), slowest first; failed calls marked ✗
- **🐢 Slowest step** and **🐘 biggest read**: the two things to look at when a job feels slow or expensive
- **✏️ Files changed**: what Claude edited
- **♻️ Cache hit**: how much of the input was served from the prompt cache (higher is cheaper)
- **Total**: wall time, steps and the job's cost

## How the numbers work

- **Total cost** is this job's real cost, from the same figures as `/cost` (shown when Claude Code reports a cost).
- **Per-agent cost** is an estimate (≈): the total split by each agent's share of the work.
- **~tokens per tool** estimates the size of what each tool returned (about 4 characters per token).

## Privacy

Turn Receipt only reads Claude Code's own session numbers and tool names. The receipt stays on your machine; `/receipt copy` only puts it on your clipboard.

## Develop

```bash
claude --plugin-dir ./turn-receipt     # run it; saving a file reloads it
claude plugin validate turn-receipt
claude plugin test turn-receipt
```

## License

MIT
