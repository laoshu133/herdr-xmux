# herdr-xmux

XMux is the personal Herdr layout and mod set used by the XMux workflow.
It keeps the Ghostty Solarized Dark palette, a single 36px tab row, horizontal
tab scrolling, compact square panel controls, and a one-pixel top focus line
for the active pane. `Issues` stays available from More actions.

The repository owns the XMux layout, theme, and `xmux-*` mods. Personal Herdr
keys and settings remain under Mackup/iCloud and are deliberately not included.

## Install

```sh
git clone git@github.com:laoshu133/herdr-xmux.git ~/works/herdr-xmux
cd ~/works/herdr-xmux
./install.sh
```

`install.sh` backs up existing XMux files under
`~/.config/herdr-app/retired/`, links the repository files into Herdr, checks
the mods, and switches the open app to the `xmux` layout when possible. It
also finds the binary inside `~/Applications/Herdr.app` when the CLI is not on
`PATH`.

Keep these files in Mackup/iCloud:

```text
.config/herdr-app/keys.json
.config/herdr-app/settings.json
```

Do not add `shared.json`, `view.json`, `window.json`, session state, or
machine-specific runtime data to this repository.
