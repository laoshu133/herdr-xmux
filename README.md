# XMux

XMux is a Herdr layout and mod set for a compact, terminal-first coding
workspace. It keeps a single 36px tab row, scrolls tabs horizontally, uses
square panel controls, stable one-pixel pane borders, and a clear one-pixel
focus accent. The palette is based on the user's Ghostty Solarized Dark theme
and is used by both the Herdr chrome and terminal panes.

![XMux preview](preview.png)

The image is a sanitized preview of the layout. It shows the layout chrome and
panel arrangement without including a personal workspace, repository, or
terminal content.

## Inspired by Estro

XMux is inspired by [Estro](https://github.com/munza/herdr-mods/tree/main/estro),
the Herdr layout for directing agents. XMux keeps Estro's useful workspace
model and panel workflow, then adapts the spacing, borders, tab behavior,
focus treatment, and colors for a personal Ghostty-like setup.

## Features

- One compact tab row with horizontal scrolling and truncated long titles.
- Tab and agent titles follow the active pane and can show a terminal's working
  directory.
- `+` creates a terminal in the active tab's working directory; Shift-click
  opens the full picker.
- Files, Changes, PRs, and Issues use compact square controls. Issues remains
  available from More actions.
- Panes share one-pixel borders and dividers. The active pane gets a one-pixel
  focus accent while inactive terminals are slightly softened.
- Pane title bars are removed where the tab row already provides the context.
- Sidebar spaces expose a quick-create action, and machines can be reordered.
- GitHub and GitLab features use the locally authenticated `gh` and `glab`
  CLIs together with the repository remote, so private deployments are
  supported without hard-coding an official hostname.

## Included files

The repository contains the `xmux` layout, a Ghostty Solarized Dark theme, and
the following mods:

| Mod | Purpose |
| --- | --- |
| `xmux-better-tabs` | Compact tabs, scrolling, titles, panel actions, and More actions |
| `xmux-better-sidebar` | Spaces, agents, machines, ordering, and quick actions |
| `xmux-better-files` | File tree and file viewer |
| `xmux-better-changes` | Changes, staging, commits, and diffs |
| `xmux-branch-pr` | Pull requests through authenticated GitHub or GitLab CLIs |
| `xmux-branch-issue` | Issue workflow for the configured issue provider |
| `xmux-new-menu` | XMux terminal and agent creation menu |
| `xmux-status` | Compact bottom status bar |

`workspace-chrome` and the other built-in workspace pieces are supplied by
Herdr itself.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

## Install

Clone the repository and run the installer:

```sh
git clone https://github.com/laoshu133/herdr-xmux.git ~/works/herdr-xmux
cd ~/works/herdr-xmux
./install.sh
```

The installer links XMux into `~/.config/herdr-app`, moves existing XMux files
to a timestamped `retired/` backup, checks each mod when `herdr-app` is
available, and switches the open app to the `xmux` layout when possible.

For a non-default Herdr configuration directory, set `HERDR_APP_HOME` before
running the installer. For an app bundle whose CLI is not on `PATH`, set
`HERDR_BIN` to the Herdr executable.

Personal keys, settings, machine connections, and session state stay outside
this repository. Keep these files in Mackup/iCloud if that is part of your
setup:

```text
.config/herdr-app/keys.json
.config/herdr-app/settings.json
```

Do not copy `shared.json`, `view.json`, `window.json`, `windows.json`, or
other runtime data into this repository.

## Updates

```sh
cd ~/works/herdr-xmux
git pull --ff-only
./install.sh
```

The installer makes a new backup before relinking files. After an update,
verify the layout with:

```sh
herdr-app check mods/xmux-better-tabs/main.js
herdr-app do layout.switch '{"name":"xmux"}'
```

## Herdr Gallery

This repository is prepared for the Herdr Gallery format. A Gallery release
needs a public GitHub repository with the `herdr-layout` topic and these files:

```text
layouts/xmux.json
mods/
RECIPE.md
preview.png
```

After the repository is public and the topic is added, Herdr normally indexes
it in the Community section within about an hour. Gallery publishing does not
review layout code, so the recipe and repository should be checked before
making the repository public. See the [Herdr Gallery](https://herdr.dev/gallery/)
for the current publishing flow.

## Privacy check

XMux does not store GitHub or GitLab tokens. Provider access is discovered from
the local authenticated CLIs at runtime. Personal Herdr configuration and
runtime state are intentionally excluded, and the repository's ignore rules
cover common environment files, certificates, and private keys.
