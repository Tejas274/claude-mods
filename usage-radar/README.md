# usage-radar

shows what's going on while claude works, right above the prompt.

![band](docs/band.png)

install (inside claude code):

```
/plugin install usage-radar --marketplace Tejas274/claude-mods
```

say `y`, pick user scope, restart. or from the terminal: `claude plugin marketplace add Tejas274/claude-mods && claude plugin install usage-radar@claude-mods --scope user`

### what you get

the band above the prompt has the model, tokens, cost, how long the job's been running, what claude is doing right now, and meters for context and the 5h/weekly limits (only if your account reports them, mine only shows context).

when a meter goes past 80% you get a little warning, and again at 95%. for context it tells you to `/compact`.

the status line at the bottom gets a short version of all that.

`/radar` opens a panel: cost / tokens / time for the job, the limits with when they reset, and one row per agent with its own cost. it also opens on its own when claude starts helper agents. on a wide terminal it docks on the right.

![panel](docs/agents-panel.png)

### about the numbers

context and limits come straight from claude code. the job cost is the real one (same as `/cost`), the per-agent split is an estimate so it has a ≈. the timer keeps going until the helpers finish too, not just the main agent.

it only reads claude code's own numbers, nothing is sent anywhere.

### changelog

- 2.0.0 renamed from savvy-progress, added context + limit meters and the warnings
- 1.2.0 panel grows to fit all the agents
- 1.1.0 timer waits for background helpers, new colours
- 1.0.0 first version

code is all in `hooks/register.tsx`. to hack on it: `claude --plugin-dir ./usage-radar`.

MIT
