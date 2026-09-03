/** Deployment configuration for language-server discovery and process launch. */
import z from 'schemastery'

/** Optional code-navigator settings accepted from `cordis.patch.yml`. */
export interface CodeNavigatorConfig {
  /** clangd executable name or absolute path. */
  clangdCommand?: string
  /** Extra clangd arguments. `--background-index` is enabled by default. */
  clangdArgs?: string[]
  /** Pyright language-server executable override. Empty uses the bundled server. */
  pyrightCommand?: string
  /** TypeScript language-server executable override. Empty uses the bundled server. */
  typescriptLanguageServerCommand?: string
  /** Maximum directory depth used while looking for project configuration. */
  projectSearchDepth?: number
  /** Maximum directories inspected during project configuration discovery. */
  projectSearchDirectoryLimit?: number
  /** Maximum files returned by the Quick Open workspace index. */
  quickOpenFileLimit?: number
  /** Largest source document sent to a language server, in bytes. */
  maxDocumentBytes?: number
}

/** Validated loader schema for {@link CodeNavigatorConfig}. */
export const Config: z<CodeNavigatorConfig> = z.object({
  clangdCommand: z.string().default('clangd'),
  clangdArgs: z.array(z.string()).default(['--background-index']),
  pyrightCommand: z.string().default(''),
  typescriptLanguageServerCommand: z.string().default(''),
  projectSearchDepth: z.number().step(1).min(0).max(16).default(4),
  projectSearchDirectoryLimit: z.number().step(1).min(1).max(10_000).default(500),
  quickOpenFileLimit: z.number().step(1).min(100).max(500_000).default(50_000),
  maxDocumentBytes: z.number().step(1).min(1_024).max(64_000_000).default(4_000_000),
})

/** Fully defaulted settings consumed by the host implementation. */
export interface ResolvedCodeNavigatorConfig {
  clangdCommand: string
  clangdArgs: readonly string[]
  pyrightCommand: string
  typescriptLanguageServerCommand: string
  projectSearchDepth: number
  projectSearchDirectoryLimit: number
  quickOpenFileLimit: number
  maxDocumentBytes: number
}

/** Apply the same defaults for direct callers that bypass Loader validation. */
export function resolveConfig(config: CodeNavigatorConfig | undefined): ResolvedCodeNavigatorConfig {
  return {
    clangdCommand: config?.clangdCommand?.trim() || 'clangd',
    clangdArgs: config?.clangdArgs ?? ['--background-index'],
    pyrightCommand: config?.pyrightCommand?.trim() ?? '',
    typescriptLanguageServerCommand: config?.typescriptLanguageServerCommand?.trim() ?? '',
    projectSearchDepth: config?.projectSearchDepth ?? 4,
    projectSearchDirectoryLimit: config?.projectSearchDirectoryLimit ?? 500,
    quickOpenFileLimit: config?.quickOpenFileLimit ?? 50_000,
    maxDocumentBytes: config?.maxDocumentBytes ?? 4_000_000,
  }
}
