/** Optional BetterSidebar adapter for the standalone persistent navigator. */
import type { Context } from '@deepseek-ai/cordis'

/** Browser-side subset of the generic sidebar extension service. */
interface SidebarService {
  registerEditorLifecycle(id: string, factory: (context: EditorContext) => void | (() => void)): () => void
  openLocation(scope: Scope, location: { path: string; line: number; character: number }, title?: string): void
  registerTopBarAction(action: { id: string; title: string; icon: 'back' | 'forward'; onClick(scope: Scope): void }): () => void
}
interface Scope { sessionId: string; cwd?: string }
interface EditorContext {
  scope: Scope; path: string; content: string; dom: HTMLElement
  getText(): string
  posAtCoords(coords: { x: number; y: number }): number | null
  onDocumentChange(listener: (text: string) => void): () => void
}
interface ContextWithSidebar extends Context { betterSidebar: SidebarService }

export const inject = ['betterSidebar']

function locationAt(text: string, position: number): { line: number; character: number; start: number } {
  const before = text.slice(0, position)
  const line = before.split('\n').length - 1
  const start = before.lastIndexOf('\n') + 1
  let word = position
  while (word > start && /[A-Za-z0-9_]/.test(text.charAt(word - 1))) word--
  return { line, character: word - start, start: word }
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
  const sidebar = (ctx as ContextWithSidebar).betterSidebar
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
  ctx.effect(() => sidebar.registerEditorLifecycle('dsh-code-navigator', ({ scope, path, content, dom, getText, posAtCoords, onDocumentChange }) => {
      let timer: number | undefined
      const status = document.createElement('div')
      let projectLabel = 'LSP'
      let started = false
      const setStatus = (state: 'detecting' | 'starting' | 'ready' | 'updating' | 'failed'): void => {
        const suffix = state === 'detecting' ? 'Detecting project…' : state === 'starting' ? 'Starting…' : state === 'ready' ? 'Ready' : state === 'updating' ? 'Updating…' : 'Failed'
        status.textContent = `${projectLabel} · ${suffix}`
      }
      status.style.cssText = 'padding:3px 8px;font:11px var(--dsw-font-code,monospace);color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l2)'
      setStatus('detecting')
      dom.parentElement?.append(status)
      void call<{ server: string | null; configPath: string | null }>('project', scope, path).then(project => {
        const config = project.configPath?.split(/[\\/]/).pop()
        projectLabel = [project.server ?? 'LSP', config].filter(Boolean).join(' · ')
        setStatus(started ? 'ready' : 'starting')
      }).catch(console.error)
      void call('open', scope, path).then(() => { started = true; setStatus('ready') }).catch(error => { setStatus('failed'); console.error(error) })
      const offChange = onDocumentChange(text => {
        if (timer !== undefined) window.clearTimeout(timer)
        setStatus('updating')
        timer = window.setTimeout(() => { void call('change', scope, path, { text }).then(() => { setStatus('ready') }).catch(error => { setStatus('failed'); console.error(error) }) }, 120)
      })
      const click = (event: MouseEvent): void => {
        if (event.button !== 0 || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
        const position = posAtCoords({ x: event.clientX, y: event.clientY })
        if (position === null) return
        event.preventDefault()
        const origin = locationAt(getText(), position)
        void call<readonly { uri: string; range: { start: { line: number; character: number } } }[]>('definition', scope, path, { position: { line: origin.line, character: origin.character } }).then(locations => {
          const target = locations[0]
          if (target === undefined) return
          const url = new URL(target.uri)
          if (url.protocol !== 'file:') return
          const destination = { path: decodeURIComponent(url.pathname), line: target.range.start.line, character: target.range.start.character }
          record(scope, { path, line: origin.line, character: origin.character }, destination)
          sidebar.openLocation(scope, destination)
        }).catch(error => { console.error('[dsh-code-navigator] definition lookup failed:', error) })
      }
      dom.addEventListener('click', click)
      return () => { if (timer !== undefined) window.clearTimeout(timer); offChange(); dom.removeEventListener('click', click); status.remove(); void call('close', scope, path).catch(console.error) }
  }), 'dsh-code-navigator: BetterSidebar adapter')
  ctx.effect(() => {
    const back = sidebar.registerTopBarAction({ id: 'dsh-code-navigator:back', title: 'Go Back', icon: 'back', onClick: scope => { move(scope, -1) } })
    const forward = sidebar.registerTopBarAction({ id: 'dsh-code-navigator:forward', title: 'Go Forward', icon: 'forward', onClick: scope => { move(scope, 1) } })
    return () => { forward(); back() }
  }, 'dsh-code-navigator: navigation actions')
}
