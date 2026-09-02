/** Standalone persistent code-navigation service and its HTTP API. */
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { detectProject, type ProjectInfo } from './project.ts'
import { PersistentNavigator, type Location, type NavigatorStatus, type Position } from './persistent-server.ts'

/** Cordis loader name shown in startup diagnostics. */
export const name = 'code-navigator'
/** Host services required by the standalone provider. */
export const inject = ['fs', 'subprocess', 'sessions', 'webServer']

/** Programmatic API available to independent UI adapters and other DSH plugins. */
export interface CodeNavigatorService {
  project(cwd: string, path: string): Promise<ProjectInfo>
  open(cwd: string, path: string): Promise<void>
  change(cwd: string, path: string, text: string): Promise<void>
  close(cwd: string, path: string): Promise<void>
  definition(cwd: string, path: string, position: Position): Promise<readonly Location[]>
  subscribe(listener: (status: NavigatorStatus) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context { codeNavigator: CodeNavigatorService }
}

interface SessionRecord { header: { cwd?: string } }
interface HttpRequest {
  url?: string
  method?: string
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}
interface HttpResponse { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }
interface RuntimeContext {
  fs: FileSystem
  subprocess: {
    resolveExecutable(command: string, env: Record<string, string>, signal?: AbortSignal): Promise<string>
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  }
  sessions: { get(id: string): SessionRecord | undefined }
  webServer: { register(route: { kind: 'prefix'; path: string; handler(req: HttpRequest, res: HttpResponse): Promise<void> }): () => void }
}

/** Resolve a path below the selected workspace, rejecting directory escapes. */
async function workspaceTarget(runtime: RuntimeContext, cwd: string, path: string) {
  const root = await runtime.fs.resolve(cwd)
  const target = await runtime.fs.resolve(path, { cwd })
  if (!runtime.fs.contains(root, target)) throw new Error('path resolves outside the workspace')
  return { root, target }
}

/** Return file-browser metadata without exposing filesystem target keys. */
async function listFiles(runtime: RuntimeContext, cwd: string, path: string) {
  const { target } = await workspaceTarget(runtime, cwd, path)
  const entries = await runtime.fs.listDir(target)
  return entries.filter(entry => entry.type === 'directory' || entry.type === 'file').map(entry => ({
    name: entry.name,
    type: entry.type,
    path: runtime.fs.processPath(entry.target),
    ...(entry.size === undefined ? {} : { size: entry.size }),
  }))
}

/** Read a text source below the selected workspace with a fixed response cap. */
async function readFile(runtime: RuntimeContext, cwd: string, path: string) {
  const { target } = await workspaceTarget(runtime, cwd, path)
  const info = await runtime.fs.stat(target)
  if (info?.type !== 'file') throw new Error('path is not a regular file')
  if ((info.size ?? 0) > 2_000_000) throw new Error('file exceeds the 2 MB viewer limit')
  return { path: runtime.fs.processPath(target), text: await runtime.fs.readText(target) }
}

function runtimeOf(ctx: Context): RuntimeContext { return ctx as Context & RuntimeContext }
function requireString(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key]
  if (typeof value !== 'string' || value === '') throw new Error(`missing or invalid "${key}"`)
  return value
}
function positionOf(payload: unknown): Position {
  const value = (payload as Record<string, unknown> | null)?.position as Record<string, unknown> | undefined
  const line = value?.line
  const character = value?.character
  if (typeof line !== 'number' || typeof character !== 'number' || !Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) throw new Error('missing or invalid "position"')
  return { line, character }
}
async function readJson(req: HttpRequest): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of req) {
    const encoded = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    bytes += encoded.byteLength
    if (bytes > 1_048_576) throw new Error('request body too large')
    chunks.push(encoded)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text) as unknown
}
function json(res: HttpResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function cwdOf(runtime: RuntimeContext, payload: unknown): string {
  const sessionId = (payload as Record<string, unknown> | null)?.sessionId
  if (typeof sessionId === 'string' && sessionId !== '') {
    const stored = runtime.sessions.get(sessionId)?.header.cwd
    if (stored !== undefined && stored !== '') return stored
  }
  return requireString(payload, 'cwd')
}

/** Install an isolated persistent navigator. It does not mount, modify, or depend on any sidebar. */
export async function apply(ctx: Context): Promise<void> {
  const runtime = runtimeOf(ctx)
  const navigator = new PersistentNavigator({ fs: runtime.fs, subprocess: runtime.subprocess })
  const service: CodeNavigatorService = {
    project: detectProject,
    async open(cwd, path) { const project = await detectProject(cwd, path); if (project.server === null) throw new Error(`unsupported source file "${path}"`); await (await navigator.workspace(cwd, project)).open(path) },
    async change(cwd, path, text) { const project = await detectProject(cwd, path); if (project.server === null) throw new Error(`unsupported source file "${path}"`); await (await navigator.workspace(cwd, project)).change(path, text) },
    async close(cwd, path) { const project = await detectProject(cwd, path); if (project.server === null) return; await (await navigator.workspace(cwd, project)).close(path) },
    async definition(cwd, path, position) { const project = await detectProject(cwd, path); if (project.server === null) return []; return await (await navigator.workspace(cwd, project)).definition(path, position) },
    subscribe: listener => navigator.subscribe(listener),
  }
  ctx.provide('codeNavigator', service)
  ctx.effect(() => runtime.webServer.register({
    kind: 'prefix', path: '/code-navigator/api',
    async handler(req, res) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return }
      const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/code-navigator/api/'.length)
      try {
        const payload = await readJson(req)
        const cwd = cwdOf(runtime, payload)
        switch (method) {
          case 'list': json(res, 200, { ok: true, value: await listFiles(runtime, cwd, requireString(payload, 'path')) }); return
          case 'read': json(res, 200, { ok: true, value: await readFile(runtime, cwd, requireString(payload, 'path')) }); return
          case 'project': { const path = requireString(payload, 'path'); json(res, 200, { ok: true, value: await service.project(cwd, path) }); return }
          case 'open': { const path = requireString(payload, 'path'); await service.open(cwd, path); json(res, 200, { ok: true, value: null }); return }
          case 'change': { const path = requireString(payload, 'path'); await service.change(cwd, path, requireString(payload, 'text')); json(res, 200, { ok: true, value: null }); return }
          case 'close': { const path = requireString(payload, 'path'); await service.close(cwd, path); json(res, 200, { ok: true, value: null }); return }
          case 'definition': { const path = requireString(payload, 'path'); json(res, 200, { ok: true, value: await service.definition(cwd, path, positionOf(payload)) }); return }
          default: json(res, 404, { ok: false, error: 'unknown code navigator API method' }); return
        }
      } catch (error) { json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
    },
  }), 'dsh-code-navigator: API routes')
  ctx.effect(() => () => navigator.dispose(), 'dsh-code-navigator: dispose persistent servers')
}

export type { Location, NavigatorStatus, Position, ProjectInfo }
