/** Cached language-server dependency detection for graceful feature degradation. */
import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ResolvedCodeNavigatorConfig } from './config.ts'
import { commandFor } from './persistent-server.ts'
import type { ProjectInfo } from './project.ts'

/** Availability of one language server in the current DSH host process. */
export interface LanguageServerAvailability {
  server: NonNullable<ProjectInfo['server']>
  available: boolean
  command: string
  source: 'bundled' | 'configured' | 'system'
  message?: string
}

interface ExecutableResolver {
  resolveExecutable(command: string, env: Record<string, string>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

const PROBES: readonly ProjectInfo[] = [
  { language: 'cpp', server: 'clangd', configPath: null },
  { language: 'python', server: 'pyright', configPath: null },
  { language: 'typescript', server: 'typescript-language-server', configPath: null },
]

/** Detect configured and packaged servers once, then reuse the result for every file. */
export class LanguageServerDependencies {
  private readonly checks = new Map<NonNullable<ProjectInfo['server']>, Promise<LanguageServerAvailability>>()

  constructor(private readonly subprocess: ExecutableResolver, private readonly config: ResolvedCodeNavigatorConfig) {}

  /** Check one project's server without starting an indexer. */
  check(project: ProjectInfo): Promise<LanguageServerAvailability | null> {
    if (project.server === null) return Promise.resolve(null)
    const existing = this.checks.get(project.server)
    if (existing !== undefined) return existing
    const pending = this.detect(project)
    this.checks.set(project.server, pending)
    return pending
  }

  /** Probe every supported language server during plugin activation. */
  all(): Promise<readonly LanguageServerAvailability[]> {
    return Promise.all(PROBES.map(async project => (await this.check(project))!))
  }

  private async detect(project: ProjectInfo): Promise<LanguageServerAvailability> {
    const configured = project.server === 'pyright'
      ? this.config.pyrightCommand !== ''
      : project.server === 'typescript-language-server'
        ? this.config.typescriptLanguageServerCommand !== ''
        : this.config.clangdCommand !== 'clangd'
    const source = project.server === 'clangd' && !configured ? 'system' : configured ? 'configured' : 'bundled'
    let command: string = project.server!
    try {
      const launch = commandFor(project, this.config)
      command = launch.command
      await this.subprocess.resolveExecutable(launch.command, {})
      return { server: project.server!, available: true, command, source }
    } catch {
      const message = source === 'bundled'
        ? `${project.server} is unavailable; reinstall dsh-code-navigator`
        : `${project.server} not found; install LLVM clangd or set clangdCommand`
      return { server: project.server!, available: false, command, source, message }
    }
  }
}
