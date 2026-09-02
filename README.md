# dsh-code-navigator

Private DeepSeek Harness code-navigation workspace built on a maintained fork of `dsh-better-sidebar` and the Harness LSP capability.

## Layout

- `packages/better-sidebar/` — vendored upstream sidebar source, kept mergeable with `omdsh-dev/DSH-better-sidebar`.
- `packages/lsp-navigation/` — language-neutral LSP bridge and CodeMirror navigation integration.

## Upstream

The sidebar source comes from <https://github.com/omdsh-dev/DSH-better-sidebar>. The repository keeps an `upstream` Git remote so upstream changes can be merged deliberately. This private repository is an imported fork, because GitHub does not allow a private native fork of a public repository.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

The first implementation target is modifier-click definition navigation for C and C++ through clangd. The protocol and UI remain language-neutral so additional configured language servers use the same path.
