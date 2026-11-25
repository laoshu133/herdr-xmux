# XMux

A terminal-first Herdr layout with compact tabs, split panes, and a sidebar for
Spaces and Agents across machines.

![XMux preview](preview.png)

## Features

- Scrollable tabs, a collapsible sidebar, and Ghostty Solarized Dark.
- Go to search by `machine/space`, tab title, or Agent task, with direct focus
  for individual Agents in split tabs.
- A floating quick terminal and live titles for shells, SSH, and Agent tasks.
- File browsing, diffs, staging, commits, GitHub PRs, GitLab MRs, and issues.

## Install

Requires Herdr and Node.js.

```sh
git clone https://github.com/laoshu133/herdr-xmux.git ~/works/herdr-xmux
cd ~/works/herdr-xmux
./install.sh
```

The installer links XMux into `~/.config/herdr-app` and activates its layout.
`HERDR_APP_HOME` overrides the config directory. `HERDR_BIN` sets the Herdr
executable. Run `git pull --ff-only && ./install.sh` from the checkout to update.

## Shortcuts

The installer adds these bindings under `layout:XMux` in `keys.json` and
preserves custom bindings.

| Shortcut | Action |
| --- | --- |
| `Cmd+P` | Open Go to. |
| `Alt+F` (`Option+F` on macOS) | Toggle Files. |
| `Option+Cmd+←/→/↑/↓` | Focus a split pane in that direction. |
| `Ctrl+Cmd+←/→` | Select Spaces / Agents. |
| `Ctrl+Cmd+↑/↓` | Cycle through tabs in Spaces or Agents in list order. |
| `Ctrl+Cmd+S` | Focus the first blocked or errored Agent, then the first unread completed Agent once all blockers clear. Herdr notifies you when none need attention. |
| `Cmd+T` | Open a terminal in the active directory. |
| `Cmd+D` / `Shift+Cmd+D` | Split right / down. |

Click `+` for a terminal or Shift-click it for the terminal and Agent menu.
The sidebar collapses to a 48px rail. On macOS the tabs clear the window
buttons when the sidebar is collapsed or hidden.

### Right panel commands

Bind these commands under `layout:XMux` in `keys.json`. Each command opens its
panel or switches to it. Invoking it again while that panel is visible hides
the right panel, just like clicking its toolbar button again.

| Panel | Command |
| --- | --- |
| Files | `xmux-tabs.button:files` |
| Changes | `xmux-tabs.button:changes` |
| PRs | `xmux-tabs.button:prs` |
| Issues | `xmux-tabs.button:issues` |

If your macOS input method intercepts `Option+F`, open Herdr's **Settings →
Keyboard** and set **Option as Alt** to **On** (`"option_as_alt": "on"` in
`settings.json`). This makes both Option keys act as Alt in Herdr.

### Optional macOS configuration

Merge these entries into your personal `keys.json`.

```json
{
  "global": {
    "cmd-b": "layout.toggle:sidebar"
  },
  "layout:XMux": {
    "cmd-ctrl-t": "xmux-tabs.new-menu",
    "cmd-shift-t": "xmux-status.reopen-closed",
    "cmd-`": "xmux-status.quick-dialog",
    "cmd-w": "xmux-status.close-current"
  },
  "terminal": {
    "cmd-r": "send:\f"
  }
}
```

- `Cmd+B` hides or shows the sidebar. `Ctrl+Cmd+T` opens the creation menu.
- `Shift+Cmd+T` opens a fresh terminal at the last closed tab's position and
  working directory.
- `` Cmd+` `` toggles the quick terminal and keeps its shell alive when hidden.
  `Cmd+W` closes the focused quick terminal, dismisses an open child
  terminal preview, or closes the current tab.
- `Cmd+R` sends a form feed for shell screen clearing.

Herdr focuses the quick terminal when its dialog opens and restores the
underlying pane when it closes. Set `"pane_scrollbars": false` in Herdr's
`settings.json` to hide the terminal pane scrollbar thumb.

## Add to chat

File menus insert paths. PR and Issue views insert links. Both actions add a
space on each side and leave the text in the draft.

- **Add to chat** inserts at the cursor and requires a live Agent in the
  focused pane.
- **Add to other chat** opens a picker on the current machine and selects the
  first Agent in the current Space when available. Use `↑/↓` to move,
  `←/→` or `Tab` to change columns, `Enter` in the Agent column or
  double-click an Agent to add, and `Esc` to cancel.

| Destination | Path format |
| --- | --- |
| Focused Agent or same Space | Relative to the Agent pane's working directory |
| Another Space on the same machine | Absolute path |
| Another machine | `source-machine:/absolute/path`, using the local `hostname` for a local source |

### Send a task by Agent alias

Hover over the Agent's sidebar number for its stable alias and Core address.
Aliases use `1` locally and `machine/1` remotely.

```sh
address=$(jq -er --arg alias 'machine/1' '."xmux-sidebar.agent-aliases"[$alias]' \
  "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/shared.json") &&
  hc get --json "$address" | jq -e '.state == "live"' >/dev/null &&
  hc send "$address" 'Your task'
```

## GitHub and GitLab

On the computer running XMux, sign in to the repository's API host with
`gh auth login --hostname HOST` or `glab auth login --hostname HOST`. XMux uses
local CLI authorization and repository access to identify the provider, even
for remote checkouts. Credentials stay with the CLI.

For SSH aliases or a different API hostname, configure PRs and the sidebar in
`${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/xmux-branch-pr/settings.json`.
Both apply settings from `mods/xmux-branch-pr/mod.json` over the built-in
defaults, then apply the local settings. Optional `tools.github` and
`tools.gitlab` entries override CLI paths.

```json
{
  "hosts": [
    { "remote": "git-company", "kind": "gitlab", "host": "code.example.com" }
  ]
}
```

Cache lifetimes are 10 minutes for CLI availability and provider detection,
1 minute for authorization, and 5 minutes for checkout discovery. PR and issue
lists cache for 60 seconds and details for 30 seconds. Use **Refresh** after
changing accounts or permissions.

## Shared mod code

Herdr confines each mod's imports to its own directory, including imports
through symlinks. XMux keeps shared source in `lib/xmux/` and generates
`mods/xmux-*/shared/` copies for the mods that use it. Each mod imports its
own copy. The shared title rules in `lib/xmux/tab-title.js` use the current
terminal program to derive automatic titles. When an Agent exits and the
shell resumes, the title follows the shell.

Edit the source in `lib/xmux/`. When adding a shared module or a new consumer,
register it in the `targets` map. Run the commands below and commit both the
source and the generated copies. The installer also runs the consistency check.
[Sync script](scripts/sync-common.mjs)

```sh
node scripts/sync-common.mjs
node scripts/sync-common.mjs --check
```

[Layout and development](RECIPE.md) · [Apache License 2.0](LICENSE)
