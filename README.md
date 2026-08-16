# dsh-plugin-manager-plus

Enhanced plugin manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — browse the community catalog, distinguish official vs third-party plugins, manage lifecycle, sync your environment via GitHub. Based on [dsh-market](https://github.com/dsh-market/dsh-market) (MIT).

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-plugin-manager-plus)](https://www.npmjs.com/package/dsh-plugin-manager-plus)
[![stars](https://img.shields.io/github/stars/cdllang/dsh-plugin-manager-plus?style=flat)](https://github.com/cdllang/dsh-plugin-manager-plus)

Open Settings → **Plugin Manager** → browse, install, manage, sync.

## Install

```sh
dsh plugin --profile web add dsh-plugin-manager-plus
```

Restart `dsh web`, then open **Settings → Plugin Manager**.

## Features

### Browse & install from the community catalog

- **Discover** — searchable, paginated catalog (750+ plugins, growing daily) with category filters, star counts, and bilingual descriptions
- **One-click install** — confirm the source, watch live progress; most plugins go live after a page refresh, no restart
- **Official / third-party badges** — every plugin is classified: official (from `deepseek-ai` / `dsh-external`, or `@deepseek-ai/*` scope) gets a blue **官方** badge; the rest are community. Click any plugin name or version to jump to its GitHub repo.

### Manage installed plugins

- **Installed** — grouped view with activation state (live / restart / inert / broken / missing), version, and source
- **Update** — per-plugin checks (npm version or pinned commit vs HEAD), one-click update or update-all
- **Enable / Disable** — toggle a plugin without uninstalling (persisted via `dsh.market.disabled`)
- **Uninstall** — two-step confirm; this-session installs are removed live
- **Local plugin marking** — plugins without a GitHub source show a **本地** badge and a grayed source (e.g. `bundles:`, `patch:`); plugins whose manifest declares a `repository` field resolve to their GitHub page automatically
- **Start a new conversation for help** — when an install fails, a button appears that generates a self-contained, secret-masked prompt; copy it and paste into a new conversation to get diagnosis and a fix

### Environment sync (F4) — 🔒 opt-in, off by default

Back up your installed third-party plugin list to a GitHub repo and restore it on another machine.

- **Off by default** — the sync tab shows a setup guide and makes no network requests until you explicitly enable it
- **Backup** — pushes `dsh-plugins.json` (names + sources + pinned commits) to your repo; local-only plugins are packed **as files** into the manifest so they can be fully restored elsewhere
- **Restore** — pulls the manifest, shows a diff, restores local plugin files automatically, and lists which online plugins remain to install
- **Local plugin files** — plugins with no GitHub/npm source are packed (path → base64) into the manifest; the size guard keeps the push under GitHub's contents-API limit
- **Privacy** — only plugin names, versions, and (for local plugins) their files leave your machine; tokens never appear in the manifest. The sync switch itself is never pushed.
- **Help on failure** — any backup/restore error shows the same "start a new conversation for help" action with a config-focused prompt (error code, message, hint, repo/branch)

## Configuration

### Environment sync setup

1. Create a GitHub repo (e.g. `me/dsh-plugins`) — public or private
2. Create a token: GitHub **Settings → Developer settings → Personal access tokens** → select **repo** or **contents:write**
3. In **Settings → Plugin Manager → Sync**, fill in `owner/repo`, the branch, and the token, then click **Enable Sync**
4. Click **Test Connection** — green means ready; red shows the exact reason

> Without a token the GitHub API is rate-limited to 60 requests/hour (enough for occasional backups); with a token it rises to 5000/hour. The token is stored only in your local config and never pushed.

## Speed

Installs prefer npm tarballs over full-repo GitHub downloads whenever a plugin publishes to npm (registry-verified against the repo to prevent name squatting). Registry installs are typically seconds; GitHub-only plugins depend on your connection to GitHub.

## Security

- Installs are restricted to sources listed in the curated [awesome-dsh-plugin](https://awesome-dsh-plugin.com) registry — anything else is rejected
- Build scripts stay blocked by default (pnpm ≥10); blocked git-hosted build scripts are auto-approved and retried once, and per-package approval is your explicit choice
- Terminal/CLI-surface plugins are flagged before you install them into the web profile
- The install endpoint accepts same-origin POST only; the plugin never phones home
- The restart endpoint requires a direct loopback client (forwarded requests are rejected) and relaunches the exact DSH entry, arguments, environment, and working directory
- Help prompts mask all token shapes (`ghp_*`, `github_pat_*`, `Bearer …`) before display
- Listing ≠ endorsement: plugins are third-party code, install sources you trust

## Submit your plugin

**This repo is the manager app, not the catalog.** The plugin list comes from the curated [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry — to get your plugin listed, open a PR **there** (one entry in the list; the market picks it up automatically, usually within a day). To make your own plugin show a GitHub link in the Installed view, add a `repository` field to its `package.json`:

```json
"repository": { "type": "git", "url": "git+https://github.com/you/your-plugin.git" }
```

## Development

```sh
npm install
npm run build       # tsc + tsdown client bundle
npm test            # vitest unit tests (92)
npm run typecheck
npm run check       # typecheck + build + restart smoke
```

### Project layout

```
src/
├── index.ts          # plugin entry
├── routes.ts         # HTTP routes (install/update/sync/help/…)
├── profile.ts        # profile filesystem reads + enable/disable + snapshot
├── install.ts        # install orchestration, recovery, allowBuilds parsing
├── sync.ts           # F4 environment sync (pack/unpack local plugins)
├── help-prompt.ts    # help prompt builders (install / sync)
├── op-queue.ts       # FIFO operation queue
├── provenance.ts     # official/third-party classification
├── dsh-cli.ts        # dsh CLI child processes + trial boot
└── client/           # React UI (MarketSection, SyncTab, HelpPromptDialog)
```

## Roadmap & feedback

- File bugs and ideas as [issues](https://github.com/cdllang/dsh-plugin-manager-plus/issues); attaching the manager's "Export log" makes diagnosis 10x faster
- This project is a fork of [dsh-market](https://github.com/dsh-market/dsh-market) — upstream improvements can be merged back

## Data source

Live from [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json) — curated entries, npm mapping, and star counts refreshed daily by CI — with a bundled snapshot as offline fallback.

## License

MIT — fork of [dsh-market](https://github.com/dsh-market/dsh-market) (MIT)
