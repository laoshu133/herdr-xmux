# XMux

XMux is a compact, terminal-first Herdr layout and mod set for working across
spaces, coding agents, split panes, and repository panels.

![XMux preview](preview.png)

A Ghostty-inspired Herdr workspace with compact tabs, split panes, and Files,
Changes, PRs, and Issues panels.

## Features

- A single 36px tab row with horizontal scrolling and truncated titles.
- Same-space tab dragging, machine ordering, and a collapsible Spaces and
  Agents sidebar.
- Go to search across machines, spaces, tabs, and Agent tasks.
- `+` starts a terminal in the active pane's directory. Shift-click opens the
  terminal and Agent creation menu.
- A draggable quick terminal and live shell and Agent titles.
- Files, Changes, PRs, and Issues panels with actions to insert paths and links
  into Agent chats.
- One-pixel pane frames, split spacing, focus treatment, and continuous shell
  boundaries.
- A Ghostty Solarized Dark theme shared by the Herdr chrome and terminals.
- GitHub and GitLab provider detection based on the repository remote and the
  locally authenticated `gh` or `glab` CLI.

## Included files

| Path | Purpose |
| --- | --- |
| `layouts/XMux.json` | The XMux window layout. |
| `themes/ghostty-solarized-dark.json` | Shared terminal and app theme. |
| `mods/xmux-tabs` | Tabs, scrolling, titles, and panel actions. |
| `mods/xmux-sidebar` | Window chrome, spaces, agents, machines, and quick actions. |
| `mods/xmux-files` | File tree and file viewer. |
| `mods/xmux-changes` | Changes, staging, commits, and diffs. |
| `mods/xmux-branch-pr` | Pull request workflow. |
| `mods/xmux-branch-issue` | Issue workflow. |
| `mods/xmux-new-menu` | Terminal and agent creation menu. |
| `mods/xmux-picker` | Go to spaces, tabs and split agents by name. |
| `mods/xmux-quick-dialog` | Floating local terminal title bar and controls. |
| `mods/xmux-status` | Bottom status bar and XMux commands. |

Herdr supplies the remaining workspace pieces, including its built-in status
and terminal components.

## Install

```sh
git clone https://github.com/laoshu133/herdr-xmux.git ~/works/herdr-xmux
cd ~/works/herdr-xmux
./install.sh
```

The installer links the layout, theme, and XMux mods into
`~/.config/herdr-app`, backs up replaced XMux files under `retired/`, checks
the mods, adds shortcuts in `layout:XMux` (preserving custom
bindings), and switches the running app to the `XMux` layout. Set
`HERDR_APP_HOME` for another configuration directory or `HERDR_BIN` when
`herdr-app` is not on `PATH`.

Keep personal `keys.json`, `settings.json`, machine connections, and runtime
state outside this repository. Mackup/iCloud can sync those files separately.

## Update

```sh
cd ~/works/herdr-xmux
git pull --ff-only
./install.sh
```

For an existing symlink installation, edits in the checkout may not reach
Herdr's configuration-folder watcher. After saving, trigger hot reload with:

```sh
touch -h ~/.config/herdr-app/mods/xmux-*
```

This notifies the watcher about the installed links; changed mods reload in
place. Target one link to reload only that mod. Panel refresh buttons update
their data rather than reload their code.

Switch to the layout manually with:

```sh
herdr-app do layout.switch '{"name":"XMux"}'
```

## Navigation and shortcuts

The sidebar's collapse button reduces it to a 48px icon rail. Use the expand
button at the bottom to restore its previous width. `Cmd+B` hides or shows the
sidebar when bound to Herdr's `layout.toggle:sidebar` action. In a windowed
macOS layout with native traffic lights, the tab bar leaves room for the
buttons when the sidebar is collapsed or hidden.

Open **Go to** with `Cmd+P` or the sidebar search button. Search by
`machine/space`, tab title, or Agent task title. Local spaces use the local
hostname. Agent titles follow the tab title rules, and selecting an individual
Agent result in a split tab focuses its pane.

### Shortcuts installed for XMux

`./install.sh` adds these bindings under `layout:XMux` in `keys.json` and
preserves custom bindings. When a new split-pane binding is active, the old
matching `Option+Cmd+Arrow` binding is disabled within XMux.

| Shortcut | Action |
| --- | --- |
| `Cmd+P` | Open Go to. |
| `Shift+Cmd+←/→/↑/↓` | Focus the split pane in that direction. |
| `Ctrl+Cmd+←` / `Ctrl+Cmd+→` | Select Spaces / Agents in the sidebar. |
| `Ctrl+Cmd+↑` / `Ctrl+Cmd+↓` | Move backward / forward through workspace tabs in Spaces or the ordered Agent list in Agents. |
| `Ctrl+Cmd+J` | Go to the first blocked or errored Agent in list order. Once those are cleared, go to the first unread completed Agent. Herdr shows a notification when no Agent needs attention. |
| `Cmd+T` | Start a terminal in the active pane's directory. |
| `Cmd+D` / `Shift+Cmd+D` | Split the current pane to the right / down. |

### Optional macOS configuration

Merge these entries into the corresponding sections of your personal
`keys.json` to enable the quick terminal, Ghostty-style screen clearing, and
the other shortcuts below. Keep your existing entries when merging the example.

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

- `Ctrl+Cmd+T` opens the terminal and Agent creation menu. `Shift+Cmd+T`
  starts a fresh terminal at the position and working directory of the most
  recently closed tab.
- `` Cmd+` `` shows or hides the quick terminal. `Cmd+W` closes it when it has
  keyboard focus and closes the current tab otherwise.
- `Cmd+R` sends a form feed in the terminal to clear the screen in shells that
  bind form feed to screen clearing.

The layout selects `ghostty-solarized-dark`. For the scrollbar behavior in the
preview, set `"pane_scrollbars": false` in Herdr's `settings.json` to hide the
terminal pane scrollbar thumb. XMux lists keep their scrollbars.

### Quick terminal and titles

The quick terminal starts in the focused local terminal's directory, or in the
local home directory when working remotely. Drag the title bar to move it.
XMux remembers its position and reuses a still-running shell after hiding the
window, switching layouts, or restarting the app. Closing the window or
exiting the shell ends the session.

The quick terminal and tabs use the live terminal title (OSC), including titles
set by remote shells over SSH. Shell titles fall back to the shell name and one
directory label. Agent tabs use the current task title, including on inactive
remote tabs. Explicit tab names take precedence, with legacy Agent program
names treated as automatic titles. New Agents start with automatic titles.

When opening the quick terminal, XMux attempts to focus it through the local
`herdr-app` CLI. Click the terminal to type if your Herdr version requires it.
Herdr 0.1.16 users can apply the [optional overlay focus patch](patches/README.md).

## Add to chat

File context menus in Files, previews, and Changes and Commits lists offer
**Add to chat** and **Add to other chat**. PR and Issue views offer the same
actions for links. For local files, **Show in Finder** starts a separate group
below the editor actions.

- **Add to chat** inserts at the cursor in the focused pane. It is enabled
  when that pane has a live Agent.
- **Add to other chat** opens a machine and Agent picker. It starts on the
  current machine and selects the first Agent in the current Space when one
  is available. Agent names use the same title rules as tabs. Use `↑` and `↓`
  to move, and `←`, `→`, or `Tab` to switch columns. Press `Enter` in the
  Agent column, double-click an Agent, or click **Add** to insert. Press `Esc`
  to cancel.

Both actions leave the text in the draft with a space on either side. XMux
temporarily uses the clipboard to paste and restores the previous plain text
when available.

| Destination | File reference |
| --- | --- |
| Focused Agent or another Agent in the same Space | Path relative to the Agent pane's working directory |
| Another Space on the same machine | Absolute path |
| Another machine | `source-machine:/absolute/path/to/file` |

When sending from this computer to a remote machine, `source-machine` is the
value returned by the local `hostname` command.

## Send a task to a sidebar agent

Each machine has its own sequence. In Spaces, rows under a machine heading
show just the number. Hover over a number to see the full alias (such as
`m5/1`) and its Core address. Local aliases are bare numbers such as `1`.
Sorting and closing a session leave its alias reserved.

You can tell an agent on the machine running XMux, “Use hc to send this task
to XMux sidebar agent `m5/1`.” Look up the alias in the Herdr app's shared
state, then use its Core address with `hc send` if the terminal is live.

```sh
address=$(jq -er --arg alias 'm5/1' '."xmux-sidebar.agent-aliases"[$alias]' \
  "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/shared.json") &&
  hc get --json "$address" | jq -e '.state == "live"' >/dev/null &&
  hc send "$address" 'Your task'
```

## Local verification

```sh
python3 -m json.tool layouts/XMux.json >/dev/null
node scripts/sync-common.mjs --check
node --test tests/*.test.mjs
find mods -path '*/xmux-*/*.js' -type f -print0 | xargs -0 -n1 node --check
for mod in mods/xmux-*; do herdr-app check "$mod"; done
herdr-app status
```

The layout uses `terminal_padding: [2, 2]`, a 28px status bar, one-pixel pane
frames, and a 0.5px outer gutter when the right panel is closed.

## Privacy

XMux does not store GitHub or GitLab tokens. Provider access is discovered from
the local CLI at runtime. Personal configuration and runtime state are not
included in the repository, and the ignore rules cover common environment
files, certificates, and private keys.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).


## Shared modules and refresh behavior

`lib/xmux/` is the source for workspace context, query caching, provider discovery,
CodeViewer, tab titles, and file menus. Herdr confines imports to each mod directory, so run
`node scripts/sync-common.mjs` after changing those files and include the generated
`mods/*/shared/` copies. The installer checks for stale copies. Node.js is required.
Herdr generates `gpui-kit.d.ts` locally under `mods/`, where Git ignores it.

New terminals keep the active terminal's exact cwd. On a file/diff tab they use
that space's project directory, including remote spaces whose persisted folder
is empty. Preview tabs retain the last repository context for Changes/PRs/Issues.

Changes reads only while visible. Local notifications debounce for 300ms; local
repositories with a working watcher poll as a 60s fallback, remote repositories
keep the configured status interval (10s by default). A hidden diff stops reading.
Hidden file viewers also stop their file/Git polls. Status reads coalesce for 1s,
repository summaries cache for 10s, and commit-file lists/diffs cache for 30min.
Stage/unstage/commit and manual refresh invalidate relevant repository reads.

PRs and Issues refresh only when visible and idle (60s by default). Lists and
branch queries cache for 60s, and detail requests cache for 30s. Equivalent
in-flight reads join one request. Small discovery metadata is shared across mod
instances. API payloads stay in bounded runtime memory.
Failed reads back off for 5–60s, keeping existing content. Read CLI calls have
explicit timeouts. Hosting requests use local gh/glab authentication even for a
remote checkout; Git operations run on that checkout's machine.

Manual refresh bypasses cached reads and errors. Successful API writes invalidate
the panel's API cache.

CodeViewer wraps native readonly Editor for ordinary source. Changes-marked source,
working-tree/commit/PR diffs share one decorated renderer: selectable native text
per column, separate line-number/background layers, common font and line height.
Decorated files over 2,000 rows fall back to the complete Editor source view.
Diff limits remain configurable (1,500 rows by default). Split columns share a
vertical viewport and scroll horizontally independently. Native TextView currently
trims whitespace at the outer boundaries of copied selections; use ordinary source
(with Changes off) when those boundary spaces must be preserved exactly.

File previews restore their owning space and machine from the current client's
space list, since Herdr syncs mod props without rewriting machine-qualified IDs.
Changes resolves a preview's source before falling back to its space's terminals
and saved directory. File trees, previews, and Changes/Commits lists share the
Files context menu; VS Code opens the owning workspace and file, using the
configured SSH target for remote files.

## Pull and merge requests

The `PRs` entry uses one panel for GitHub Pull Requests and GitLab Merge
Requests. Its mod ID remains `xmux-branch-pr`. GitHub uses the bundled helper
and `gh`; GitLab uses REST API v4 through `glab api`. Hosting requests run
locally with the CLI's existing authentication, including for remote spaces.
Git discovery, fetch and worktree creation run on the checkout's machine.
No hosting token is stored by XMux.

The footer shows the repository and branch. Click it to open the repository
on its hosting service when the panel has a single repository in context.

The adapters share repository/request identities and UI contracts, but keep
native review, approval, CI and merge semantics. GitLab displays `!IID`,
Discussions and Pipelines. Project policy controls merge methods and squash;
rebasing the source branch is a separate operation. Missing permissions,
unsupported approval endpoints and unavailable/truncated diffs are reported
explicitly. Creating a request and managing reviewers remain available on the
hosting service; there is no local creation or formal review editor.

Repository identity includes platform, API hostname and full project path;
request identity adds the PR number or MR IID. Lists, drafts, saved views and
worktree bindings cannot cross hosts. New worktree bindings use versioned JSON
in `branch.<branch>.herdr-pr`; old `owner/repo#number` GitHub bindings still
work. Fetches use the target project's PR/MR head ref and verify its SHA before
creating a worktree. Worktree folders also include platform and host.

GitLab Discussions and Pipelines load on first use, and job traces load on
demand. Discussions, checks, jobs, and logs cache for 30 seconds. Versioned
diffs cache for one hour by source and base commits. Cached content stays
visible during background refreshes. Write requests require an explicit retry.

### Hosting CLI setup and caches

Install `gh` for GitHub or `glab` for GitLab on the computer running XMux.
Sign in to the API host with `gh auth login --hostname HOST` or
`glab auth login --hostname HOST`. Automatic discovery reads the host and
project path from the Git remote, checks which CLIs are available with
`--version`, checks their authorization for that exact host, and verifies
repository access through the CLI's API command. This also supports GitHub
Enterprise and self-hosted GitLab.

| Discovery check | Cache lifetime |
| --- | --- |
| CLI availability per executable | 10 minutes |
| CLI authorization per executable and host | 1 minute |
| Provider resolution per repository | 10 minutes |
| Repository discovery per checkout | 5 minutes |

Use the panel's **Refresh** action after changing CLI accounts or project
policies. It clears the relevant discovery and data caches and fetches again.

For the PRs panel and sidebar, set an explicit host mapping when the remote
uses an SSH alias, the SSH host differs from the API host, or both CLIs can
access the repository. Save overrides in
`${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/xmux-branch-pr/settings.json`.
The file uses a top-level object. `tools` is optional and defaults to `gh`
and `glab`.

```json
{
  "tools": {
    "github": "/path/to/gh",
    "gitlab": "/path/to/glab"
  },
  "hosts": [
    { "remote": "git-company", "kind": "gitlab", "host": "code.example.com" }
  ]
}
```

The example maps `git@git-company:group/subgroup/project.git` to the GitLab API
at `code.example.com`. Mod manifests can also supply these keys inside their
`settings` object. The local override file takes precedence.
