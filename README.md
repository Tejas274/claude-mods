# claude-mods

**Free, open mods for [Claude Code](https://claude.com/claude-code).** Each one changes how Claude Code looks or works, and installs with one command.

![Savvy Progress](savvy-progress/docs/agents-panel.png)

## Mods

| Mod | What it does | Install (inside Claude Code) |
|---|---|---|
| [**Savvy Progress**](./savvy-progress) | Live model, tokens, cost and timer above the prompt, a status line, and an Agents panel with per-agent cost (`/savvy`) | `/plugin install savvy-progress --marketplace Tejas274/claude-mods` |
| [**Turn Receipt** 🧾](./turn-receipt) | An itemized receipt for every job: per agent, per tool, slowest step, biggest read, files changed, cache hit. `/receipt` to view, `/receipt copy` to share | `/plugin install turn-receipt --marketplace Tejas274/claude-mods` |

More coming soon.

## Install

**Inside Claude Code:** copy the install line from the table. Answer `y` to add the marketplace, choose **user** scope, and restart Claude Code.

**From your terminal:** add the marketplace once, then install any mod:

```bash
claude plugin marketplace add Tejas274/claude-mods
claude plugin install savvy-progress@claude-mods
```

**Update:** run `/plugin`, open **Marketplaces**, and update `claude-mods`.
**Remove:** `/plugin uninstall <mod-name>`.

## What's a mod?

A mod is a small piece of code that plugs into Claude Code's events: when you send a prompt, when Claude uses a tool, when an agent starts or finishes. It can **watch** them, **change** them, **block** them, or **draw** something new on screen (a status line, a band above the prompt, a side panel, a pop-up).

Mods only see what Claude Code gives them. Each mod's README says exactly what it reads and whether it sends anything anywhere.

## Make your own

1. Copy [`template/`](./template) and rename it, for example `my-mod/`.
2. In `my-mod/.claude-plugin/plugin.json`, set `"name": "my-mod"` and a description.
3. Run it live (saving a file reloads it):
   ```bash
   claude --plugin-dir ./my-mod
   ```
4. Check it:
   ```bash
   claude plugin validate my-mod
   claude plugin test my-mod
   ```
5. Add it to [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) and to the table above.
6. Publish: `./publish.sh "Add my-mod"`.

## Repo layout

```
claude-mods/
├── .claude-plugin/marketplace.json   ← the list of mods
├── savvy-progress/                   ← one folder per mod
├── template/                         ← starting point for a new mod
├── publish.sh                        ← validate + commit + push
└── README.md
```

## Contributing

Ideas, bugs and new mods are welcome: open an issue or a pull request.

## License

[MIT](LICENSE): free to use, change and share.
