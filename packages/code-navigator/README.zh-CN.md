# dsh-code-navigator

[English](README.md)

`dsh-code-navigator` 是一个独立的 DSH 代码导航插件。它为每个工作区保持语言服务器进程和已打开文档的生命周期，减少每次跳转时重复启动 LSP 的延迟，支持 DSH `0.1.2-alpha.3` 及同一 `0.1.2` 版本线的后续版本。

插件提供 C/C++ clangd、Python Pyright、JavaScript/TypeScript Language Server。Pyright、TypeScript Language Server 和 TypeScript 随 npm 包安装；clangd 是 LLVM 原生程序，由操作系统提供，也可以通过配置指定路径。

## 安装 clangd 以启用 C/C++ 跳转

clangd 对插件界面是可选依赖，但 C/C++ 索引和定义跳转必须使用它。建议先检查：

```sh
clangd --version
```

没有安装时可按系统安装：

```sh
# macOS（Homebrew）
brew install llvm

# Debian / Ubuntu
sudo apt-get install clangd
```

Windows 可以安装 LLVM 官方发行版并把 `clangd.exe` 加入 `PATH`。如果 clangd 不在 `PATH`，请通过 `clangdCommand` 配置绝对路径。其他系统和最新下载方式见 [clangd 官方安装文档](https://clangd.llvm.org/installation)。

Pyright、TypeScript Language Server 和 TypeScript 已经随插件安装，不需要用户再全局安装。

## 主要功能

- Cmd/Ctrl 点击符号跳转到定义，按住修饰键时显示下划线。
- 前进和后退导航历史。
- 自动发现并提前加载 `compile_commands.json`。
- 工作区目录树、可编辑文件标签页、路径面包屑和标签页右键关闭菜单。
- Cmd/Ctrl+P 按文件名搜索当前工作区。
- 持久语言服务器和状态显示。
- BetterSidebar 可选；不存在时使用插件自带工作台。

## 自动依赖探测与降级

插件激活时自动探测三种语言服务器并缓存探测结果，不会为了探测而启动服务器进程。

| 能力 | 默认来源 | 缺失时行为 |
| --- | --- | --- |
| C/C++ clangd | 系统 LLVM/clangd | 不启动 C/C++ 预热和索引；文件浏览、编辑和高亮继续可用 |
| Python Pyright | 随插件安装 | 只关闭 Python 跳转并提示重新安装插件 |
| TypeScript Language Server | 随插件安装 | 只关闭 JS/TS 跳转并提示重新安装插件 |
| BetterSidebar | 可选插件 | 自动加载独立代码工作台 |

缺少 clangd 不会让插件启动失败，也不会让界面一直处于 Pending。打开 C/C++ 文件时状态栏会显示 clangd 不可用；安装 clangd 并重启 DSH 后会自动启用 C/C++ 索引。

## 安装

从 npm 安装到 Web profile：

```sh
dsh plugin --profile web add dsh-code-navigator
dsh --profile web --dump-config
dsh web
```

使用本地压缩包时，把包名替换为压缩包路径。

## 配置

默认配置无需修改。需要指定 clangd 或限制扫描规模时，可在 profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: code-navigator
  name: dsh-code-navigator
  config:
    clangdCommand: /opt/homebrew/opt/llvm/bin/clangd
    clangdArgs: [--background-index, --clang-tidy]
    projectSearchDepth: 4
    projectSearchDirectoryLimit: 500
    quickOpenFileLimit: 50000
    maxDocumentBytes: 4000000
```

`pyrightCommand` 和 `typescriptLanguageServerCommand` 用于覆盖插件内置服务。保持为空即可使用随包版本。

## 与 BetterSidebar 共存

宿主插件只负责项目识别、依赖探测、持久 LSP 进程、文档生命周期和跳转请求，不注册 `ctx.lsp`，也不拥有 Sidebar。

存在 BetterSidebar 时，浏览器适配器通过通用编辑器生命周期和顶栏扩展点加入跳转、状态和历史按钮；不存在时加载独立工作台。两种界面不会同时创建代码编辑区域，因此可以与其他插件共存。

## 开发与发布检查

```sh
pnpm install
pnpm --filter dsh-code-navigator check:release
pnpm --filter dsh-code-navigator pack
```

`check:release` 执行严格类型检查、单元测试、干净生产构建和 npm 包结构检查。`prepack` 会重新构建 `lib/`，避免发布陈旧产物。

稳定版会以 npm 的 `latest` 标签发布。要被 Community Market 发现，需要发布这个精确的稳定版本、公开 `repository` 中声明的 GitHub 仓库，并验证与当前 DSH Desktop 内置 DSH/Cordis runtime 的兼容性。预发布版本仅用于本地压缩包或 npm 预发布测试。

## 安全与资源限制

文件和项目请求通过当前 DSH 文件系统服务解析，规范化路径越出工作区时会被拒绝。请求体、源码文件、项目配置扫描和快速文件索引都有上限。语言服务器通过 DSH subprocess 服务运行，并在插件卸载时终止。
