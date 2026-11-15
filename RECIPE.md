# XMux

XMux is a compact, terminal-first Herdr layout for a developer who works with
multiple spaces, coding agents, and repository panels. It is inspired by
[Estro](https://github.com/munza/herdr-mods/tree/main/estro), then reshaped
around a Ghostty Solarized Dark palette and a single scrolling tab row.

![XMux preview](preview.png)

This recipe describes the files in this directory. The files beside it are the
working implementation.

## What you see

The window is a row with a 268px sidebar and a work area. The sidebar contains
the XMux spaces and agents list, followed by a 28px footer. The work area has a
36px tab row, the active tab's panes, an optional 368px right panel, and a 28px
status bar.

The tab row scrolls horizontally instead of wrapping. Long titles are
truncated, and titles are derived from the active pane so a terminal can show
its current working directory. Its plus action starts a terminal in the active
tab's current directory and appends it to the end; Shift-click opens the
terminal and agent picker.

Files, Changes, PRs, and Issues are panel actions. Issues is kept in More
actions to leave the main toolbar compact. The right panels use square corners,
compact headers, and the same divider treatment as the rest of the layout.

Panes use one-pixel borders and one-pixel spacing with no pane title bar. Parent
dividers provide the continuous outer and tab/body/status rules, while each pane
keeps a visible frame and each right-panel root carries its own left rule.

The layout uses `themes/ghostty-solarized-dark.json` for the terminal and app
colors. Provider panels discover access through the locally authenticated
`gh` or `glab` CLI and the repository remote, which also supports private
GitHub Enterprise and GitLab deployments.

## Files and mods

- `layouts/XMux.json` is the layout.
- `themes/ghostty-solarized-dark.json` is the shared terminal and panel theme.
- `mods/xmux-workspace-chrome` owns the XMux brand bar and its continuous bottom rule.
- `mods/xmux-better-tabs` owns tabs and panel actions.
- `mods/xmux-better-sidebar` owns spaces, agents, machines, and quick actions.
- `mods/xmux-better-files` and `mods/xmux-better-changes` own the right panels.
- `mods/xmux-branch-pr` and `mods/xmux-branch-issue` own repository workflows.
- `mods/xmux-new-menu` and `mods/xmux-status` provide XMux-specific supporting
  UI.

`workspace-status` and the remaining built-in workspace pieces are supplied by
Herdr and are not copied into this repository.

## Installing XMux

From an empty Herdr configuration, read `~/.config/herdr-app/AGENTS.md`, then
install the repository with:

```sh
./install.sh
```

The installer links the layout, theme, and all `xmux-*` mods. It keeps any
previous files in `~/.config/herdr-app/retired/` and runs `herdr-app check` when
the CLI is available. Switch layouts with:

```sh
herdr-app do layout.switch '{"name":"XMux"}'
```

Personal keys and settings belong in the user's own backup or sync system.
They are deliberately absent from this layout package.

## Provider requirements

The PR and issue mods do not treat the public GitHub hostname as the provider
check. They inspect the repository remote and the local authenticated `gh` or
`glab` CLI. Install and authenticate the CLI that matches the repository host;
the mods then show the corresponding provider state or a useful missing-access
message.

## Done when

- `herdr-app check` passes for each `mods/xmux-*` mod.
- `layout.switch {"name":"XMux"}` opens the layout.
- The tab row stays one line at narrow widths and long titles truncate.
- The Files, Changes, PRs, and More actions controls open the expected panels.
- A terminal started from `+` uses the active pane's working directory and is
  appended at the end of the tab list.
