# dsh-code-navigator

`dsh-code-navigator` is an independent DSH plugin that keeps a language-server process and its opened documents alive per workspace.

It packages the LSP service definition required by its stdio provider, so a normal profile installation does not depend on a separately installed DSH LSP plugin.

It exposes `ctx.codeNavigator` to other host plugins and `/code-navigator/api/*` for browser adapters. It deliberately owns neither a sidebar nor `ctx.lsp`, so it can coexist with `dsh-better-sidebar`, the stock LSP provider, and other UI plugins.

Supported servers are clangd for C/C++, Pyright for Python, and `typescript-language-server` for JavaScript/TypeScript. clangd discovers `compile_commands.json` from the active workspace, preferring the root, `build/`, and `out/build/`.

The public lifecycle is `open`, `change`, `definition`, and `close`. A UI adapter should call `open` when a code tab opens, `change` as its document changes, and `close` when the last matching tab closes; definition calls then avoid the transient `didOpen`/`didClose` work of the standard provider.

When `dsh-better-sidebar` is also enabled, the optional browser adapter adds Cmd/Ctrl-click definition lookup to code tabs, back and forward controls in the sidebar's top-right control strip, and a compact LSP project/server status line below the editor. The host navigator remains usable by other plugins without this adapter.

Without BetterSidebar, the browser module mounts a lightweight right-side workbench. Enter a workspace path, browse files, open text files, and press Cmd/Ctrl+Enter at the cursor to follow a definition. The workbench is not mounted when BetterSidebar is available, so the two plugins never create competing editor panes.
