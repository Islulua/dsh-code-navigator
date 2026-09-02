# dsh-code-navigator

`dsh-code-navigator` is an independent DSH plugin that keeps a language-server process and its opened documents alive per workspace.

It exposes `ctx.codeNavigator` to other host plugins and `/code-navigator/api/*` for browser adapters. It deliberately owns neither a sidebar nor `ctx.lsp`, so it can coexist with `dsh-better-sidebar`, the stock LSP provider, and other UI plugins.

Supported servers are clangd for C/C++, Pyright for Python, and `typescript-language-server` for JavaScript/TypeScript. clangd discovers `compile_commands.json` from the active workspace, preferring the root, `build/`, and `out/build/`.

The public lifecycle is `open`, `change`, `definition`, and `close`. A UI adapter should call `open` when a code tab opens, `change` as its document changes, and `close` when the last matching tab closes; definition calls then avoid the transient `didOpen`/`didClose` work of the standard provider.
