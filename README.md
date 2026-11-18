# XMux

XMux is a compact, terminal-first Herdr layout and mod set for working across
spaces, coding agents, split panes, and repository panels.

![XMux preview](preview.png)

A Ghostty-inspired Herdr workspace with compact tabs, split panes, and Files,
Changes, PRs, and Issues panels.

## Features

- A single 36px tab row with horizontal scrolling and truncated titles.
- Same-space tab dragging, machine ordering, and space and agent navigation.
- `+` starts a terminal in the active pane's directory; Shift-click opens the
  terminal and agent picker. `Cmd+Ctrl+T` opens the same picker.
- `Cmd+Shift+T` starts a fresh terminal in the most recently closed tab's
  directory, at its previous position. It does not resume the old process.
- `` Cmd+` `` toggles a draggable local terminal over XMux. Hiding keeps the
  shell running; closing it or exiting the shell removes the window.
- Files, Changes, PRs, and Issues panels with repository-aware actions.
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

## Personal shortcuts used with XMux

These mappings belong in the personal Mackup/iCloud-managed `keys.json`:

```text
cmd-ctrl-left    -> xmux-sidebar.show-spaces
cmd-ctrl-right   -> xmux-sidebar.show-agents
cmd-ctrl-up      -> xmux-status.cross-tab-prev
cmd-ctrl-down    -> xmux-status.cross-tab-next
cmd-ctrl-j       -> xmux-status.focus-attention
cmd-ctrl-t       -> xmux-tabs.new-menu
cmd-shift-t      -> xmux-status.reopen-closed
cmd-r (terminal) -> send form feed, matching Ghostty
cmd-` (XMux)     -> xmux-status.quick-dialog
cmd-w (XMux)     -> xmux-status.close-current
cmd-t (XMux)     -> xmux-status.new-terminal
cmd-d (XMux)     -> xmux-status.split-right
cmd-shift-d (XMux) -> xmux-status.split-down
```

The XMux bindings belong in a `layout:XMux` section. Ctrl+Cmd+Left selects
Spaces and Ctrl+Cmd+Right selects Agents. Ctrl+Cmd+Up/Down cycles through
workspace tabs in Spaces and the ordered Agent list in Agents.
Ctrl+Cmd+J jumps to the first blocked
Agent in list order. After all blocked Agents clear, it jumps to the first
unread completed Agent or shows a notification when there is no pending work.

`close-current` closes the quick terminal when it has keyboard focus,
otherwise it closes the current tab.
The terminal starts in the focused local terminal's directory, or the local
home directory when working remotely. Drag its title bar to move it; its
position is remembered. Switching layouts hides it; returning to XMux and
toggling it reuses the shell. App restarts also reuse a still-running shell.
Opening or reopening quietly attempts `pane.focus` through the local
`herdr-app` control CLI. Clients that support overlay terminal focus do so
automatically; otherwise click the terminal to type. Unsupported commands or
a missing CLI leave the draggable window usable without an error toast.
Each opening retries, so future Herdr support takes effect automatically.
The optional [overlay focus patch](patches/README.md) adds support to 0.1.16.

The current personal setup also uses `ghostty-solarized-dark` and disables
Herdr's terminal pane scrollbar thumb with `pane_scrollbars: false`; XMux
mod lists retain Herdr's scrolling scrollbar behavior.

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

New terminals keep the active terminal's exact cwd. On a file/diff tab they use
that space's project directory, including remote spaces whose persisted folder
is empty. Preview tabs retain the last repository context for Changes/PRs/Issues.

Changes reads only while visible. Local notifications debounce for 300ms; local
repositories with a working watcher poll as a 60s fallback, remote repositories
keep the configured status interval (10s by default). A hidden diff stops reading.
Hidden file viewers also stop their file/Git polls. Status reads coalesce for 1s,
repository summaries cache for 10s, and commit-file lists/diffs cache for 30min.
Stage/unstage/commit and manual refresh invalidate relevant repository reads.

PRs/Issues refresh only when visible and idle (60s by default). Lists and branch
queries cache for 60s; details/jobs for 30s; repository discovery for 5min and
provider detection for 10min. Equivalent in-flight reads join one request.
Provider discovery checks which hosting CLIs are installed and authenticated for
the Git remote's host, then verifies the repository through the matching CLI.
Small discovery metadata is shared across mod instances; API payloads stay in
bounded runtime memory.
Failed reads back off for 5–60s, keeping existing content. Read CLI calls have
explicit timeouts. Hosting requests use local gh/glab authentication even for a
remote checkout; Git operations run on that checkout's machine.

Manual refresh bypasses cached reads and errors. Successful API writes invalidate
the panel's API cache. After changing CLI accounts or login state, use manual
refresh; account changes made outside Herdr are not automatically detected.

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

Agent tabs follow Core's current task title, including inactive remote tabs.
Legacy labels matching the agent's program name are treated as automatic titles;
other explicit tab names take precedence. New agents start without a fixed tab name.

## Pull and merge requests

The `PRs` entry uses one panel for GitHub Pull Requests and GitLab Merge
Requests. Its mod ID remains `xmux-branch-pr`. GitHub uses the bundled helper
and `gh`; GitLab uses REST API v4 through `glab api`. Hosting requests run
locally with the CLI's existing authentication, including for remote spaces.
Git discovery, fetch and worktree creation run on the checkout's machine.
No hosting token is stored by XMux.

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

The panel caches lists for 60 seconds and details/discussions/CI for 30 seconds.
GitLab Discussions and Pipelines load on first use; job traces load on demand.
Versioned diffs are cached by source and base commits. Cached content remains
visible during background refreshes; hidden panels stop polling. Writes
invalidate the affected repository, and write requests are never retried
automatically. Refresh explicitly clears hosting metadata and data caches;
use it after changing CLI accounts or project policies. The sidebar shares
provider discovery and reads the panel's CLI/host settings.

Optional `settings` in `mods/xmux-branch-pr/mod.json`:

```json
{
  "tools": {
    "github": "/path/to/gh",
    "gitlab": "/path/to/glab"
  },
  "hosts": [
    { "remote": "git-company", "kind": "gitlab", "host": "code.company.com" }
  ]
}
```

The example maps `git@git-company:group/subgroup/project.git` to the GitLab API
at `code.company.com`. Use a mapping when the Git remote uses an SSH alias or an
SSH host that differs from the API host. Log in to the API host with
`gh auth login --hostname HOST` or `glab auth login --hostname HOST`.
