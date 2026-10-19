# turn-receipt 🧾

when claude finishes a job you get a receipt for it.

![receipt](docs/receipt.png)

install (inside claude code):

```
/plugin install turn-receipt --marketplace Tejas274/claude-mods
```

say `y`, pick user scope, restart. or from the terminal: `claude plugin marketplace add Tejas274/claude-mods && claude plugin install turn-receipt@claude-mods --scope user`

### how it works

once the whole job is done (helpers included) a toast pops up, something like `🧾 Receipt #1 · 0:48 · 19 steps · 3 agents · ≈$0.36`.

`/receipt` opens it. `/receipt copy` puts it on your clipboard as plain text if you want to paste it in slack or a PR.

on the receipt: every agent with its model, time and cost, every tool with calls / time / roughly how much text it sent back (failed calls show in red), the slowest step, the biggest read, files changed, cache hit %, and the total.

stuff like launching helpers or updating the to-do list doesn't count for slowest/biggest, so those point at actual work.

### about the numbers

the total is the real cost for the job (same as `/cost`) when claude code reports one. per-agent cost is an estimate. "~tokens" per tool is a rough guess, about 4 characters per token.

nothing is sent anywhere, `/receipt copy` only touches your clipboard.

to hack on it: `claude --plugin-dir ./turn-receipt`, code is in `hooks/register.tsx`.

MIT
