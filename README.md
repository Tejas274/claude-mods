# claude-mods

made these while figuring out how claude code mods work. two so far.

![usage-radar and turn-receipt in Claude Code](docs/hero.png)

**usage-radar** sits above the prompt and shows what's happening while claude works: model, tokens, cost, time, context, and the 5h/weekly limits if your plan reports them (mine doesn't, so I only get context). warns you at 80% and 95%. `/radar` opens a panel with every agent and roughly what each one costs.

**turn-receipt** prints a receipt when a job is done. agents, tools, slowest step, biggest read, files changed, cache hits, total cost. `/receipt` shows it, `/receipt copy` copies it as text.

radar is the live view, receipt is the summary after.

### install

inside claude code:

```
/plugin install usage-radar --marketplace Tejas274/claude-mods
/plugin install turn-receipt --marketplace Tejas274/claude-mods
```

say `y` to add the marketplace, pick user scope, restart.

or from the terminal:

```bash
claude plugin marketplace add Tejas274/claude-mods
claude plugin install usage-radar@claude-mods --scope user
claude plugin install turn-receipt@claude-mods --scope user
```

updating: `/plugin` → marketplaces → update claude-mods. removing: `/plugin uninstall usage-radar` (or turn-receipt).

needs a recent claude code since mods are pretty new.

for a team: drop this in your repo's `.claude/settings.json` and everyone who opens the project gets both (claude code asks them to trust it once):

```json
{
  "extraKnownMarketplaces": {
    "claude-mods": { "source": { "source": "github", "repo": "Tejas274/claude-mods" } }
  },
  "enabledPlugins": {
    "usage-radar@claude-mods": true,
    "turn-receipt@claude-mods": true
  }
}
```

if your company manages claude code settings, an admin might need to allow outside marketplaces first.

both of these only read what claude code already gives them. nothing gets sent anywhere.

### making one

copy `template/`, rename it, change the name in `.claude-plugin/plugin.json`, then run it with `claude --plugin-dir ./your-mod` (it reloads on save). `claude plugin validate` and `claude plugin test` to check it. add it to `.claude-plugin/marketplace.json` and push.

issues / PRs welcome.

MIT
