/** Persistent document lifecycle on top of the public DSH stdio transport. */
import { fileURLToPath } from 'node:url'
import { extname } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  LspConnection,
  canonicalizeWorkspace,
  normalizeLocations,
  readHostSource,
} from '@deepseek-ai/dsh-lsp-stdio'
import type { ProjectInfo } from './project.ts'

/** A zero-based UTF-16 source coordinate. */
export interface Position { line: number; character: number }
/** A source range returned by an LSP server. */
export interface Range { start: Position; end: Position }
/** A filesystem location returned by a definition request. */
export interface Location { uri: string; range: Range }
/** One observable persistent-server phase. */
export type NavigatorPhase = 'idle' | 'starting' | 'ready' | 'failed'
/** Status visible to adapters without exposing an LSP transport. */
export interface NavigatorStatus { workspace: string; server: string; phase: NavigatorPhase; openDocuments: number; message?: string }
/** Public shape returned by dsh-lsp-stdio's canonical-workspace helper. */
interface HostWorkspace { target: FsTarget; canonicalPath: string; fileUrl: string }

interface SubprocessService {
  resolveExecutable(command: string, env: Record<string, string>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** Runtime dependencies supplied by a DSH host profile. */
export interface NavigatorRuntime { fs: FileSystem; subprocess: SubprocessService }

interface DocumentState { uri: string; languageId: string; version: number; text: string; references: number }

const LANGUAGE_ID: Record<NonNullable<ProjectInfo['language']>, string> = {
  cpp: 'cpp', python: 'python', typescript: 'typescript',
}

function commandFor(project: ProjectInfo): { command: string; args: string[] } {
  switch (project.server) {
    case 'clangd':
      return {
        command: process.execPath,
        args: [fileURLToPath(new URL('../scripts/clangd-auto.mjs', import.meta.url)), '--background-index'],
      }
    case 'pyright': return { command: 'pyright-langserver', args: ['--stdio'] }
    case 'typescript-language-server': return { command: 'typescript-language-server', args: ['--stdio'] }
    case null: throw new Error('no language server is configured for this file')
  }
}

/** One initialized LSP process and the documents deliberately held open in it. */
export class PersistentWorkspace {
  private connection: LspConnection | undefined
  private readonly documents = new Map<string, DocumentState>()
  private phase: NavigatorPhase = 'idle'
  private message: string | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(
    readonly workspace: HostWorkspace,
    readonly project: ProjectInfo,
    private readonly runtime: NavigatorRuntime,
    private readonly publish: (status: NavigatorStatus) => void,
  ) {}

  /** Snapshot used by status routes and visual adapters. */
  status(): NavigatorStatus {
    return {
      workspace: this.workspace.canonicalPath,
      server: this.project.server ?? 'none',
      phase: this.phase,
      openDocuments: this.documents.size,
      ...(this.message === undefined ? {} : { message: this.message }),
    }
  }

  private emit(): void { this.publish(this.status()) }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private async ensureConnection(): Promise<LspConnection> {
    if (this.connection !== undefined && !this.connection.failed) return this.connection
    this.phase = 'starting'
    this.message = undefined
    this.emit()
    const launch = commandFor(this.project)
    const executable = await this.runtime.subprocess.resolveExecutable(launch.command, {})
    const connection = new LspConnection({
      command: executable,
      args: launch.args,
      cwd: this.workspace.canonicalPath,
      env: {},
      maxMessageBytes: 16_000_000,
      maxStderrBytes: 1_000_000,
      killGraceMs: 2_000,
      configuration: null,
    }, spec => this.runtime.subprocess.spawn(spec), async (method) => {
      if (method === 'workspace/configuration') return null
      throw new Error(`unsupported language-server request "${method}"`)
    })
    try {
      const initialized = await connection.request('initialize', {
        processId: null,
        rootUri: this.workspace.fileUrl,
        workspaceFolders: [{ uri: this.workspace.fileUrl, name: 'workspace' }],
        capabilities: { general: { positionEncodings: ['utf-16'] }, workspace: { workspaceFolders: true, configuration: true }, textDocument: { synchronization: { dynamicRegistration: false }, definition: { linkSupport: true } } },
        initializationOptions: null,
      }) as { capabilities?: { positionEncoding?: string } }
      if (initialized.capabilities?.positionEncoding !== undefined && initialized.capabilities.positionEncoding !== 'utf-16') throw new Error(`server selected unsupported position encoding ${initialized.capabilities.positionEncoding}`)
      await connection.notify('initialized', {})
      this.connection = connection
      this.phase = 'ready'
      this.emit()
      return connection
    } catch (error) {
      connection.terminate()
      this.phase = 'failed'
      this.message = error instanceof Error ? error.message : String(error)
      this.emit()
      throw error
    }
  }

  /** Open a disk-backed document once. Call only inside this workspace queue. */
  private async ensureDocument(path: string, retain: boolean): Promise<DocumentState> {
    const existing = this.documents.get(path)
    if (existing !== undefined) {
      if (retain) existing.references += 1
      return existing
    }
    const source = await readHostSource(this.runtime.fs, path, this.workspace, 4_000_000)
    const languageId = this.project.language === null ? 'plaintext' : LANGUAGE_ID[this.project.language]
    const connection = await this.ensureConnection()
    await connection.notify('textDocument/didOpen', { textDocument: { uri: source.fileUrl, languageId, version: 1, text: source.text } })
    const document = { uri: source.fileUrl, languageId, version: 1, text: source.text, references: retain ? 1 : 0 }
    this.documents.set(path, document)
    this.emit()
    return document
  }

  /** Open a disk-backed document once and retain it until an adapter closes it. */
  open(path: string): Promise<void> {
    return this.enqueue(async () => { await this.ensureDocument(path, true) })
  }

  /** Apply an editor's complete current text without closing its LSP document. */
  change(path: string, text: string): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.ensureDocument(path, false)
      if (document.text === text) return
      document.version += 1
      document.text = text
      const connection = await this.ensureConnection()
      await connection.notify('textDocument/didChange', { textDocument: { uri: document.uri, version: document.version }, contentChanges: [{ text }] })
    })
  }

  /** Release one editor reference, closing the document when the last tab leaves. */
  close(path: string): Promise<void> {
    return this.enqueue(async () => {
      const document = this.documents.get(path)
      if (document === undefined) return
      if (document.references > 1) {
        document.references -= 1
        return
      }
      this.documents.delete(path)
      if (this.connection !== undefined && !this.connection.failed) await this.connection.notify('textDocument/didClose', { textDocument: { uri: document.uri } })
      this.emit()
    })
  }

  /** Resolve a definition while retaining the source document in the LSP process. */
  definition(path: string, position: Position): Promise<readonly Location[]> {
    return this.enqueue(async () => {
      const document = await this.ensureDocument(path, false)
      const connection = await this.ensureConnection()
      const payload = await connection.request('textDocument/definition', { textDocument: { uri: document.uri }, position })
      return normalizeLocations(payload)
    })
  }

  /** Terminate the process after closing the documents it owns. */
  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      const connection = this.connection
      this.documents.clear()
      this.connection = undefined
      if (connection !== undefined && !connection.failed) {
        try { await connection.request('shutdown', null); await connection.notify('exit', null) } catch { connection.terminate() }
      }
      connection?.terminate()
      this.phase = 'idle'
      this.emit()
    })
  }
}

/** Owns the persistent sessions for all workspaces in one code-navigator plugin instance. */
export class PersistentNavigator {
  private readonly workspaces = new Map<string, PersistentWorkspace>()
  private readonly listeners = new Set<(status: NavigatorStatus) => void>()

  constructor(private readonly runtime: NavigatorRuntime) {}

  subscribe(listener: (status: NavigatorStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish = (status: NavigatorStatus): void => { for (const listener of this.listeners) listener(status) }

  /** Resolve one source into its stable workspace process slot. */
  async workspace(cwd: string, project: ProjectInfo): Promise<PersistentWorkspace> {
    const resolved = await canonicalizeWorkspace(this.runtime.fs, cwd) as HostWorkspace
    const key = `${resolved.canonicalPath}\u0000${project.server ?? 'none'}`
    const existing = this.workspaces.get(key)
    if (existing !== undefined) return existing
    const created = new PersistentWorkspace(resolved, project, this.runtime, this.publish)
    this.workspaces.set(key, created)
    return created
  }

  /** Stop every owned server at plugin unload. */
  async dispose(): Promise<void> { await Promise.allSettled([...this.workspaces.values()].map(workspace => workspace.dispose())); this.workspaces.clear() }
}
