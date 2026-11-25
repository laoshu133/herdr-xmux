# Herdr overlay terminal focus

XMux now uses Herdr's native dialog for quick-terminal focus. This patch is
for the earlier draggable-window implementation on Herdr 0.1.16.

The patch applies to herdrdev/herdr-app commit
`034f8b85f7e6bb71f8ff55cb4a80c548b2578c0f` (tag `v0.1.16`). It extends the existing
command to prefer the frontmost visible overlay terminal, without switching
the underlying tab or taking focus from a modal overlay above it. It includes
a native regression test and updates the agent guide and API documentation.

In a checkout of that commit, initialize the Ghostty submodule and use Zig
0.16.0, then run:

```sh
git apply /path/to/herdr-xmux/patches/herdr-app-0.1.16-overlay-focus.patch
cargo test --locked
HERDR_APP_RELEASE=1 cargo build --release --locked
```

`HERDR_APP_RELEASE=1` retains normal upstream update checks in the installed
bundle. Test with a scratch `HERDR_APP_HOME`, `HC_SESSION` and
`XDG_STATE_HOME`; never launch the test build against the real home. After
backing up the installed app, replace its executable atomically and sign
the bundle locally. Quit and reopen Herdr to use the new executable.

An upstream update can replace this local patch. Apply it only to the source
commit above.
