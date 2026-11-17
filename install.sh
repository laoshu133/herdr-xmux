#!/bin/sh
set -eu

APP_HOME=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$APP_HOME/retired/xmux-github-$STAMP"

HERDR_BIN=${HERDR_BIN:-}
if [ -z "$HERDR_BIN" ]; then
  HERDR_BIN=$(command -v herdr-app 2>/dev/null || :)
fi
if [ -z "$HERDR_BIN" ] && [ -x "$HOME/Applications/Herdr.app/Contents/MacOS/Herdr" ]; then
  HERDR_BIN="$HOME/Applications/Herdr.app/Contents/MacOS/Herdr"
fi

# Keep installation and validation in lockstep when a mod is added or removed.
XMUX_MODS='
xmux-tabs
xmux-sidebar
xmux-files
xmux-changes
xmux-branch-pr
xmux-branch-issue
xmux-new-menu
xmux-quick-dialog
xmux-status'

node "$REPO_ROOT/scripts/sync-common.mjs" --check

mkdir -p "$APP_HOME/layouts" "$APP_HOME/themes" "$APP_HOME/mods" "$BACKUP"

backup_target() {
  target=$1
  if [ -e "$target" ] || [ -L "$target" ]; then
    relative=${target#"$APP_HOME"/}
    mkdir -p "$BACKUP/$(dirname "$relative")"
    mv "$target" "$BACKUP/$relative"
  fi
}

link_target() {
  source=$1
  target=$2
  backup_target "$target"
  ln -s "$source" "$target"
}

link_target "$REPO_ROOT/layouts/XMux.json" "$APP_HOME/layouts/XMux.json"
link_target "$REPO_ROOT/themes/ghostty-solarized-dark.json" "$APP_HOME/themes/ghostty-solarized-dark.json"

for mod in $XMUX_MODS; do
  link_target "$REPO_ROOT/mods/$mod" "$APP_HOME/mods/$mod"
done

for mod in $XMUX_MODS; do
  if [ -n "$HERDR_BIN" ]; then
    "$HERDR_BIN" check "$APP_HOME/mods/$mod/main.js" >/dev/null
  fi
done

node "$REPO_ROOT/scripts/configure-keys.mjs" "$APP_HOME" "$BACKUP"

if [ -n "$HERDR_BIN" ]; then
  "$HERDR_BIN" do layout.switch '{"name":"XMux"}' >/dev/null 2>&1 || true
fi
printf '%s\n' "Installed XMux from $REPO_ROOT"
printf '%s\n' "Backups: $BACKUP"
