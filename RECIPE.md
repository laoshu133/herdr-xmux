# XMux layout and development

| Path | Contents |
| --- | --- |
| `layouts/XMux.json` | 36px tabs, 268px sidebar (48px collapsed), 368px right panel, and 28px status bar. |
| `themes/ghostty-solarized-dark.json` | App and terminal theme. |
| `mods/xmux-*` | XMux navigation, terminals, and repository panels. |
| `lib/xmux/` | Shared source for the mods. |

Run `node scripts/sync-common.mjs` after editing `lib/xmux/` and commit the
generated `mods/*/shared/` copies. Herdr's local `gpui-kit.d.ts` files are
Git-ignored.

```sh
node scripts/sync-common.mjs --check
node --test tests/*.test.mjs
for mod in mods/xmux-*; do herdr-app check "$mod/main.js"; done
```

For a symlink installation, `touch -h ~/.config/herdr-app/mods/xmux-*` triggers
mod reload. Use the matching path if `HERDR_APP_HOME` is set.

[Install](README.md#install) · [Shortcuts](README.md#shortcuts) · [Hosting setup](README.md#github-and-gitlab)
