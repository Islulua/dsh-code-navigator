/** Optional BetterSidebar adapter for the standalone persistent navigator. */
import type { Context } from '@deepseek-ai/cordis'
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** Browser-side subset of the generic sidebar extension service. */
interface SidebarService {
  registerEditorExtension(id: string, factory: (context: { scope: Scope; path: string; content: string }) => Extension | readonly Extension[]): () => void
  openLocation(scope: Scope, location: { path: string; line: number; character: number }, title?: string): void
}
interface Scope { sessionId: string; cwd?: string }
interface ContextWithSidebar extends Context { betterSidebar: SidebarService }

export const inject = ['betterSidebar']

function wordStart(view: EditorView, position: number): number {
  const line = view.state.doc.lineAt(position)
  let offset = position - line.from
  while (offset > 0 && /[A-Za-z0-9_]/.test(line.text.charAt(offset - 1))) offset -= 1
  return line.from + offset
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
  ctx.effect(() => sidebar.registerEditorExtension('dsh-code-navigator', ({ scope, path, content }) => {
    const sync = ViewPlugin.fromClass(class {
      private timer: number | undefined
      constructor(private readonly view: EditorView) { void call('open', scope, path).catch(console.error) }
      update(update: { docChanged: boolean; state: EditorView['state'] }): void {
        if (!update.docChanged) return
        if (this.timer !== undefined) window.clearTimeout(this.timer)
        this.timer = window.setTimeout(() => { void call('change', scope, path, { text: this.view.state.doc.toString() }).catch(console.error) }, 120)
      }
      destroy(): void {
        if (this.timer !== undefined) window.clearTimeout(this.timer)
        void call('close', scope, path).catch(console.error)
      }
    })
    return [sync, EditorView.domEventHandlers({
      click(event, view) {
        if (event.button !== 0 || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (position === null) return false
        event.preventDefault()
        const start = wordStart(view, position)
        const line = view.state.doc.lineAt(start)
        void call<readonly { uri: string; range: { start: { line: number; character: number } } }[]>('definition', scope, path, {
          position: { line: line.number - 1, character: start - line.from },
        }).then(locations => {
          const target = locations[0]
          if (target === undefined) return
          const url = new URL(target.uri)
          if (url.protocol !== 'file:') return
          sidebar.openLocation(scope, {
            path: decodeURIComponent(url.pathname),
            line: target.range.start.line,
            character: target.range.start.character,
          })
        }).catch(error => { console.error('[dsh-code-navigator] definition lookup failed:', error) })
        return true
      },
    })]
  }), 'dsh-code-navigator: BetterSidebar adapter')
}
