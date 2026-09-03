/** Optional BetterSidebar adapter for the standalone persistent navigator. */
import type { Context } from '@deepseek-ai/cordis'
import { mountNavigatorWorkbench, type NavigatorWorkspaceSource } from './workbench.tsx'

/** Browser-side subset of the generic sidebar extension service. */
interface SidebarService {
  registerEditorLifecycle(id: string, factory: (context: EditorContext) => void | (() => void)): () => void
  openLocation(scope: Scope, location: { path: string; line: number; character: number }, title?: string): void
  registerTopBarAction(action: { id: string; title: string; icon: 'back' | 'forward'; onClick(scope: Scope): void }): () => void
}
interface Scope { sessionId: string; cwd?: string }
interface EditorContext {
  scope: Scope; path: string; dom: HTMLElement
  getText(): string
  posAtCoords(coords: { x: number; y: number }): number | null
  onDocumentChange(listener: (text: string) => void): () => void
}

// The host service is independent. The sidebar is only an optional browser
// adapter, so it must never make this client module wait for activation.
export const inject: readonly string[] = ['sessions']

interface ClientSessions {
  list: {
    getSnapshot(): { current?: string; byId: Record<string, { cwd?: string }> }
    subscribe(listener: () => void): () => void
  }
}

function locationAt(text: string, position: number): { line: number; character: number } {
  const before = text.slice(0, position)
  const line = before.split('\n').length - 1
  const lineStart = before.lastIndexOf('\n') + 1
  let wordStart = position
  while (wordStart > lineStart && /[A-Za-z0-9_]/.test(text.charAt(wordStart - 1))) wordStart--
  return { line, character: wordStart - lineStart }
}

async function call<T>(method: string, scope: Scope, path: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/code-navigator/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: scope.sessionId, ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }), path, ...extra }),
  })
  const payload = await response.json() as { ok: boolean; value?: T; error?: string }
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? `code navigator ${method} failed`)
  return payload.value as T
}

/** Register Cmd/Ctrl-click and persistent document notifications when the sidebar is available. */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as unknown as ClientSessions
  let warmedWorkspace: string | undefined
  const warmCurrentWorkspace = (): void => {
    const snapshot = sessions.list.getSnapshot()
    const sessionId = snapshot.current
    const cwd = sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd
    if (sessionId === undefined || cwd === undefined || cwd === '') return
    const key = `${sessionId}\u0000${cwd}`
    if (key === warmedWorkspace) return
    warmedWorkspace = key
    void call('warm', { sessionId, cwd }, cwd).catch(error => {
      console.warn('[dsh-code-navigator] workspace warm-up failed:', error)
    })
  }
  warmCurrentWorkspace()
  ctx.effect(() => sessions.list.subscribe(warmCurrentWorkspace), 'dsh-code-navigator: workspace warm-up')
  const sidebar = ctx.get('betterSidebar') as SidebarService | undefined
  if (sidebar === undefined) {
    const workspaceSource: NavigatorWorkspaceSource = {
      getSnapshot: () => {
        const snapshot = sessions.list.getSnapshot()
        return snapshot.current === undefined ? '' : snapshot.byId[snapshot.current]?.cwd ?? ''
      },
      subscribe: listener => sessions.list.subscribe(listener),
    }
    ctx.effect(() => mountNavigatorWorkbench(workspaceSource), 'dsh-code-navigator: standalone workbench')
    return
  }
  const histories = new Map<string, { entries: Array<{ path: string; line: number; character: number }>; index: number }>()
  const same = (left: { path: string; line: number; character: number }, right: { path: string; line: number; character: number }): boolean => left.path === right.path && left.line === right.line && left.character === right.character
  const move = (scope: Scope, delta: -1 | 1): void => {
    const history = histories.get(scope.sessionId)
    const target = history?.entries[(history.index ?? 0) + delta]
    if (history === undefined || target === undefined) return
    history.index += delta
    sidebar.openLocation(scope, target)
  }
  const record = (scope: Scope, origin: { path: string; line: number; character: number }, target: { path: string; line: number; character: number }): void => {
    const history = histories.get(scope.sessionId) ?? { entries: [], index: -1 }
    const entries = history.entries.slice(0, history.index + 1)
    if (entries.length === 0 || !same(entries[entries.length - 1]!, origin)) entries.push(origin)
    if (!same(entries[entries.length - 1]!, target)) entries.push(target)
    histories.set(scope.sessionId, { entries: entries.slice(-100), index: Math.min(entries.length, 100) - 1 })
  }
  ctx.effect(() => sidebar.registerEditorLifecycle('dsh-code-navigator', ({ scope, path, dom, getText, posAtCoords, onDocumentChange }) => {
    let timer: number | undefined
    const status = document.createElement('div')
    let projectLabel = 'LSP'
    let enabled = false
    let disposed = false
    const setStatus = (state: 'detecting' | 'starting' | 'ready' | 'updating' | 'failed'): void => {
      const suffix = state === 'detecting' ? 'Detecting project…' : state === 'starting' ? 'Starting…' : state === 'ready' ? 'Ready' : state === 'updating' ? 'Updating…' : 'Failed'
      status.textContent = `${projectLabel} · ${suffix}`
    }
    status.style.cssText = 'padding:3px 8px;font:11px var(--dsw-font-code,monospace);color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l2)'
    setStatus('detecting')
    dom.parentElement?.append(status)
    void call<{ server: string | null; configPath: string | null; available: boolean; message?: string }>('project', scope, path).then(async project => {
      const config = project.configPath?.split(/[\\/]/).pop()
      projectLabel = [project.server ?? 'LSP', config].filter(Boolean).join(' · ')
      if (project.server === null) { status.textContent = 'Plain text'; return }
      if (!project.available) { status.textContent = `${projectLabel} · ${project.message ?? 'Unavailable'}`; return }
      if (disposed) return
      setStatus('starting')
      await call('open', scope, path)
      if (disposed) { void call('close', scope, path).catch(console.error); return }
      enabled = true
      setStatus('ready')
    }).catch(error => {
      setStatus('failed')
      console.error(error)
    })
    const offChange = onDocumentChange(text => {
      if (!enabled) return
      if (timer !== undefined) window.clearTimeout(timer)
      setStatus('updating')
      timer = window.setTimeout(() => { void call('change', scope, path, { text }).then(() => { setStatus('ready') }).catch(error => { setStatus('failed'); console.error(error) }) }, 120)
    })
    let hover: HTMLElement | undefined
    let hoverDecoration: { textDecoration: string; textUnderlineOffset: string; cursor: string } | undefined
    let lastTarget: EventTarget | null = null
    const clearHover = (): void => {
      if (hover === undefined || hoverDecoration === undefined) return
      hover.style.textDecoration = hoverDecoration.textDecoration
      hover.style.textUnderlineOffset = hoverDecoration.textUnderlineOffset
      hover.style.cursor = hoverDecoration.cursor
      hover = undefined
      hoverDecoration = undefined
    }
    const updateHover = (target: EventTarget | null, modified: boolean): void => {
      lastTarget = target
      if (!enabled || !modified || !(target instanceof Element)) { clearHover(); return }
      const candidate = target.closest('span')
      if (candidate === null || !dom.contains(candidate)) { clearHover(); return }
      if (candidate === hover) return
      clearHover()
      hover = candidate as HTMLElement
      hoverDecoration = { textDecoration: hover.style.textDecoration, textUnderlineOffset: hover.style.textUnderlineOffset, cursor: hover.style.cursor }
      hover.style.textDecoration = 'underline'
      hover.style.textUnderlineOffset = '2px'
      hover.style.cursor = 'pointer'
    }
    const mousemove = (event: MouseEvent): void => { updateHover(event.target, event.metaKey || event.ctrlKey) }
    const modifierChange = (event: KeyboardEvent): void => { updateHover(lastTarget, event.metaKey || event.ctrlKey) }
    const click = (event: MouseEvent): void => {
      if (!enabled || event.button !== 0 || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const position = posAtCoords({ x: event.clientX, y: event.clientY })
      if (position === null) return
      event.preventDefault()
      const origin = locationAt(getText(), position)
      void call<readonly { uri: string; range: { start: { line: number; character: number } } }[]>('definition', scope, path, { position: origin }).then(locations => {
        const target = locations[0]
        if (target === undefined) return
        const url = new URL(target.uri)
        if (url.protocol !== 'file:') return
        const destination = { path: decodeURIComponent(url.pathname), line: target.range.start.line, character: target.range.start.character }
        record(scope, { path, ...origin }, destination)
        sidebar.openLocation(scope, destination)
      }).catch(error => { console.error('[dsh-code-navigator] definition lookup failed:', error) })
    }
    dom.addEventListener('click', click)
    dom.addEventListener('mousemove', mousemove)
    window.addEventListener('keydown', modifierChange)
    window.addEventListener('keyup', modifierChange)
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
      offChange()
      clearHover()
      dom.removeEventListener('click', click)
      dom.removeEventListener('mousemove', mousemove)
      window.removeEventListener('keydown', modifierChange)
      window.removeEventListener('keyup', modifierChange)
      status.remove()
      if (enabled) void call('close', scope, path).catch(console.error)
    }
  }), 'dsh-code-navigator: BetterSidebar adapter')
  ctx.effect(() => {
    const back = sidebar.registerTopBarAction({ id: 'dsh-code-navigator:back', title: 'Go Back', icon: 'back', onClick: scope => { move(scope, -1) } })
    const forward = sidebar.registerTopBarAction({ id: 'dsh-code-navigator:forward', title: 'Go Forward', icon: 'forward', onClick: scope => { move(scope, 1) } })
    return () => { forward(); back() }
  }, 'dsh-code-navigator: navigation actions')
}
