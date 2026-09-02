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
// The host service is independent. The sidebar is only an optional browser
// adapter, so it must never make this client module wait for activation.
export const inject: readonly string[] = []

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

/** Call the standalone browser API, which intentionally has no session dependency. */
async function standaloneCall<T>(method: string, cwd: string, path: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/code-navigator/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, path, ...extra }),
  })
  const payload = await response.json() as { ok: boolean; value?: T; error?: string }
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? `code navigator ${method} failed`)
  return payload.value as T
}

interface FileEntry { name: string; type: 'file' | 'directory'; path: string; size?: number }
interface TextFile { path: string; text: string }
interface NavigationLocation { path: string; line: number; character: number }

function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return separator <= 0 ? path : trimmed.slice(0, separator)
}

/** Mount the lightweight navigator window used only when BetterSidebar is absent. */
function mountStandaloneWorkbench(): () => void {
  const launcher = document.createElement('button')
  launcher.textContent = '⌘'
  launcher.title = 'Code Navigator'
  launcher.style.cssText = 'position:fixed;right:12px;top:48px;z-index:50;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#24292f);padding:6px 9px;cursor:pointer'
  const panel = document.createElement('div')
  panel.dataset.dshCodeNavigatorWorkbench = ''
  panel.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:min(760px,70vw);z-index:49;display:none;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#24292f);border-left:1px solid var(--dsw-alias-border-l2,#d0d7de);font:13px system-ui,sans-serif'
  panel.innerHTML = '<div style="height:40px;display:flex;gap:6px;align-items:center;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de)"><strong style="white-space:nowrap">Code Navigator</strong><input data-cwd placeholder="Workspace path" style="flex:1;min-width:0"><button data-load>Open</button><button data-back title="Go Back" disabled>←</button><button data-forward title="Go Forward" disabled>→</button><button data-close title="Close">×</button></div><div style="display:flex;height:calc(100% - 40px)"><aside style="width:220px;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l2,#d0d7de)"><div style="display:flex;gap:4px;padding:6px;border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de)"><button data-up title="Parent directory">↑</button><span data-tree-path style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span></div><div data-tree style="overflow:auto;padding:6px"></div></aside><main style="flex:1;min-width:0;display:flex;flex-direction:column"><div data-status style="padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);color:var(--dsw-alias-label-secondary,#57606a)">Choose a workspace</div><textarea data-editor spellcheck="false" style="flex:1;border:0;resize:none;padding:10px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;outline:none"></textarea></main></div>'
  document.body.append(launcher, panel)
  const cwdInput = panel.querySelector<HTMLInputElement>('[data-cwd]')!
  const tree = panel.querySelector<HTMLElement>('[data-tree]')!
  const treePathLabel = panel.querySelector<HTMLElement>('[data-tree-path]')!
  const status = panel.querySelector<HTMLElement>('[data-status]')!
  const editor = panel.querySelector<HTMLTextAreaElement>('[data-editor]')!
  const back = panel.querySelector<HTMLButtonElement>('[data-back]')!
  const forward = panel.querySelector<HTMLButtonElement>('[data-forward]')!
  let cwd = localStorage.getItem('dsh-code-navigator:cwd') ?? ''
  let currentPath = ''
  let treePath = ''
  let changeTimer: number | undefined
  let opened = false
  const history: NavigationLocation[] = []
  let historyIndex = -1
  cwdInput.value = cwd
  const show = (): void => { panel.style.display = 'block'; launcher.style.display = 'none' }
  const hide = (): void => { panel.style.display = 'none'; launcher.style.display = 'block' }
  const updateHistoryActions = (): void => {
    back.disabled = historyIndex <= 0
    forward.disabled = historyIndex < 0 || historyIndex >= history.length - 1
  }
  const closeCurrent = async (): Promise<void> => {
    if (changeTimer !== undefined) { window.clearTimeout(changeTimer); changeTimer = undefined }
    if (!opened || currentPath === '') return
    await standaloneCall('close', cwd, currentPath)
    opened = false
  }
  const cursorAt = (line: number, character: number): void => {
    const lines = editor.value.split('\n')
    const offset = lines.slice(0, line).join('\n').length + (line === 0 ? 0 : 1) + Math.min(character, lines[line]?.length ?? 0)
    editor.selectionStart = editor.selectionEnd = offset
    editor.focus()
  }
  const openFile = async (path: string, location?: Pick<NavigationLocation, 'line' | 'character'>): Promise<void> => {
    await closeCurrent()
    const file = await standaloneCall<TextFile>('read', cwd, path)
    currentPath = file.path
    editor.value = file.text
    const project = await standaloneCall<{ server: string | null; configPath: string | null }>('project', cwd, currentPath)
    status.textContent = `${currentPath} · ${project.server ?? 'plain text'}${project.configPath === null ? '' : ` · ${project.configPath.split('/').pop()}`}`
    if (project.server !== null) {
      await standaloneCall('open', cwd, currentPath)
      opened = true
    }
    if (location !== undefined) cursorAt(location.line, location.character)
  }
  const renderDirectory = async (path: string): Promise<void> => {
    const entries = await standaloneCall<readonly FileEntry[]>('list', cwd, path)
    treePath = path
    treePathLabel.textContent = path === cwd ? '.' : path.slice(cwd.length).replace(/^[\\/]/, '')
    tree.replaceChildren(...entries.map(entry => {
      const button = document.createElement('button')
      button.textContent = `${entry.type === 'directory' ? '▸' : '□'} ${entry.name}`
      button.style.cssText = 'display:block;width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:3px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      button.onclick = () => {
        if (entry.type === 'file') void openFile(entry.path).catch(error => { status.textContent = String(error) })
        else void renderDirectory(entry.path).catch(error => { status.textContent = String(error) })
      }
      return button
    }))
  }
  const moveHistory = (delta: -1 | 1): void => {
    const target = history[historyIndex + delta]
    if (target === undefined) return
    historyIndex += delta
    updateHistoryActions()
    status.textContent = 'Opening location…'
    void openFile(target.path, target).catch(error => { status.textContent = String(error) })
  }
  const recordNavigation = (origin: NavigationLocation, target: NavigationLocation): void => {
    const entries = history.slice(0, historyIndex + 1)
    const previous = entries[entries.length - 1]
    if (previous === undefined || previous.path !== origin.path || previous.line !== origin.line || previous.character !== origin.character) entries.push(origin)
    const last = entries[entries.length - 1]
    if (last === undefined || last.path !== target.path || last.line !== target.line || last.character !== target.character) entries.push(target)
    history.splice(0, history.length, ...entries)
    historyIndex = entries.length - 1
    if (history.length > 100) { history.shift(); historyIndex-- }
    updateHistoryActions()
  }
  const load = (): void => {
    const nextCwd = cwdInput.value.trim()
    if (nextCwd === '') return
    status.textContent = 'Loading workspace…'
    void closeCurrent().then(async () => {
      cwd = nextCwd
      currentPath = ''
      editor.value = ''
      history.splice(0)
      historyIndex = -1
      updateHistoryActions()
      localStorage.setItem('dsh-code-navigator:cwd', cwd)
      await renderDirectory(cwd)
      status.textContent = cwd
    }).catch(error => { status.textContent = String(error) })
  }
  panel.querySelector<HTMLButtonElement>('[data-load]')!.onclick = load
  panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = hide
  panel.querySelector<HTMLButtonElement>('[data-up]')!.onclick = () => {
    if (treePath !== '' && treePath !== cwd) void renderDirectory(parentDirectory(treePath)).catch(error => { status.textContent = String(error) })
  }
  back.onclick = () => { moveHistory(-1) }
  forward.onclick = () => { moveHistory(1) }
  launcher.onclick = show
  const jumpAtCursor = (): void => {
    if (currentPath === '') return
    const before = editor.value.slice(0, editor.selectionStart)
    const line = before.split('\n').length - 1
    const character = before.length - (before.lastIndexOf('\n') + 1)
    void standaloneCall<readonly { uri: string; range: { start: { line: number; character: number } } }[]>('definition', cwd, currentPath, { position: { line, character } }).then(locations => {
      const target = locations[0]
      if (target === undefined) { status.textContent = 'No definition found'; return }
      const targetPath = decodeURIComponent(new URL(target.uri).pathname)
      const destination = { path: targetPath, line: target.range.start.line, character: target.range.start.character }
      recordNavigation({ path: currentPath, line, character }, destination)
      void openFile(destination.path, destination).catch(error => { status.textContent = String(error) })
    }).catch(error => { status.textContent = String(error) })
  }
  editor.addEventListener('click', event => {
    if (!(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    jumpAtCursor()
  })
  editor.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
    event.preventDefault()
    jumpAtCursor()
  })
  editor.addEventListener('input', () => {
    if (!opened || currentPath === '') return
    if (changeTimer !== undefined) window.clearTimeout(changeTimer)
    status.textContent = 'LSP · Updating…'
    changeTimer = window.setTimeout(() => {
      changeTimer = undefined
      void standaloneCall('change', cwd, currentPath, { text: editor.value }).then(() => { status.textContent = `${currentPath} · LSP · Ready` }).catch(error => { status.textContent = String(error) })
    }, 120)
  })
  return () => {
    if (changeTimer !== undefined) window.clearTimeout(changeTimer)
    void closeCurrent().catch(console.error)
    launcher.remove()
    panel.remove()
  }
}

/** Register Cmd/Ctrl-click and persistent document notifications when the sidebar is available. */
export function apply(ctx: Context): void {
  const sidebar = ctx.get('betterSidebar') as SidebarService | undefined
  if (sidebar === undefined) { ctx.effect(mountStandaloneWorkbench, 'dsh-code-navigator: standalone workbench'); return }
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
        if (!modified || !(target instanceof Element)) { clearHover(); return }
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
      dom.addEventListener('mousemove', mousemove)
      window.addEventListener('keydown', modifierChange)
      window.addEventListener('keyup', modifierChange)
      return () => {
        if (timer !== undefined) window.clearTimeout(timer)
        offChange()
        clearHover()
        dom.removeEventListener('click', click)
        dom.removeEventListener('mousemove', mousemove)
        window.removeEventListener('keydown', modifierChange)
        window.removeEventListener('keyup', modifierChange)
        status.remove()
        void call('close', scope, path).catch(console.error)
      }
  }), 'dsh-code-navigator: BetterSidebar adapter')
  ctx.effect(() => {
    const back = sidebar.registerTopBarAction({ id: 'dsh-code-navigator:back', title: 'Go Back', icon: 'back', onClick: scope => { move(scope, -1) } })
    const forward = sidebar.registerTopBarAction({ id: 'dsh-code-navigator:forward', title: 'Go Forward', icon: 'forward', onClick: scope => { move(scope, 1) } })
    return () => { forward(); back() }
  }, 'dsh-code-navigator: navigation actions')
}
