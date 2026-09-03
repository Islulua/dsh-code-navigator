# dsh-code-navigator

[简体中文](README.zh-CN.md) · [Plugin documentation](packages/code-navigator/README.md)

Persistent, VS Code-style source navigation for DeepSeek Harness. The plugin works with BetterSidebar when it is installed and provides its own Explorer, tabs, breadcrumb, editor, and Quick Open workbench when it is not.

> Status: `0.1.0-alpha.21` release candidate for DSH `0.1.2-alpha.3+`. The npm package is not yet a stable Community Market release.

## Features

| Navigation | Workspace UI | Language services |
| --- | --- | --- |
| Cmd/Ctrl-click definitions | Explorer tree and editable tabs | Persistent clangd for C/C++ |
| Back and forward history | Clickable path breadcrumb | Bundled Pyright for Python |
| Modifier-hover underline | Tab close/context menu | Bundled TypeScript Language Server |
| Cmd/Ctrl+P file search | LSP status and index warm-up | Automatic dependency detection |

## Graceful degradation

Language servers are detected during activation and the result is cached. Missing tools disable only their language feature:

- clangd is optional. Without it, C/C++ files still open with syntax highlighting, but C/C++ indexing and definition lookup stay disabled.
- Pyright, TypeScript Language Server, and TypeScript ship with the plugin. A damaged or incomplete installation disables that server and leaves the workbench usable.
- BetterSidebar is optional. Without it, the standalone workbench is mounted automatically.

```mermaid
flowchart LR
  Workspace[DSH workspace] --> Navigator[Code Navigator host]
  Navigator --> Detect{Server available?}
  Detect -->|yes| Persistent[Persistent LSP process]
  Detect -->|no| Viewer[File browser + editor]
  Persistent --> Sidebar[BetterSidebar adapter]
  Persistent --> Workbench[Standalone workbench]
  Viewer --> Sidebar
  Viewer --> Workbench
```

## Install a development archive

```sh
pnpm install
pnpm --filter dsh-code-navigator check:release
pnpm --filter dsh-code-navigator pack
dsh plugin --profile web add file:./packages/code-navigator/dsh-code-navigator-0.1.0-alpha.21.tgz
dsh web
```

See the [plugin README](packages/code-navigator/README.md) for configuration, dependency ownership, API integration, and release constraints.

## Repository layout

- `packages/code-navigator/` — independently publishable plugin.
- `packages/better-sidebar/` — upstream-based compatibility fixture; it is not a runtime dependency of the navigator.

The sidebar source tracks [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) through the `upstream` Git remote.

## Development

```sh
pnpm install
pnpm --filter dsh-code-navigator check:release
pnpm peers check
```

Licensed under MIT. See the package's [third-party notices](packages/code-navigator/THIRD_PARTY_NOTICES.md) for bundled runtime components.
