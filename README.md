# dsh-code-navigator

Development workspace for the independent `dsh-code-navigator` plugin and a maintained `dsh-better-sidebar` fork used for compatibility testing.

## Layout

- `packages/code-navigator/` — independently publishable DSH bundle with a persistent LSP host and an optional browser workbench.
- `packages/better-sidebar/` — vendored upstream source kept mergeable with `omdsh-dev/DSH-better-sidebar` for adapter compatibility testing.

## Upstream

The sidebar source comes from <https://github.com/omdsh-dev/DSH-better-sidebar>. The repository keeps an `upstream` Git remote so upstream changes can be merged deliberately. This private repository is an imported fork, because GitHub does not allow a private native fork of a public repository.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

Build and publish `packages/code-navigator/` from that directory. The package bundles Pyright and TypeScript Language Server; clangd remains a configurable system dependency supplied by LLVM.
