#!/bin/sh
set -eu

APP_HOME=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$APP_HOME/retired/xmux-github-$STAMP"

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

link_target "$REPO_ROOT/layouts/xmux.json" "$APP_HOME/layouts/xmux.json"
link_target "$REPO_ROOT/themes/ghostty-solarized-dark.json" "$APP_HOME/themes/ghostty-solarized-dark.json"

for mod in \
  xmux-better-tabs \
  xmux-better-sidebar \
  xmux-better-files \
  xmux-better-changes \
  xmux-branch-pr \
  xmux-branch-issue \
  xmux-new-menu \
  xmux-status \
  xmux-pane-focus
do
  link_target "$REPO_ROOT/mods/$mod" "$APP_HOME/mods/$mod"
done

for mod in \
  xmux-better-tabs \
  xmux-better-sidebar \
  xmux-better-files \
  xmux-better-changes \
  xmux-branch-pr \
  xmux-branch-issue \
  xmux-new-menu \
  xmux-status \
  xmux-pane-focus
do
  herdr-app check "$APP_HOME/mods/$mod/main.js" >/dev/null
done

herdr-app do layout.switch '{"name":"xmux"}' >/dev/null 2>&1 || true
printf '%s\n' "Installed XMux from $REPO_ROOT"
printf '%s\n' "Backups: $BACKUP"
