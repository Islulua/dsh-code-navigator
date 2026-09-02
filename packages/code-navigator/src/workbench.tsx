/**
 * Independent code-navigation workbench. It reuses the Sidebar's CodeMirror
 * editor model and token-driven visual language, but owns its own tabs and
 * file tree so BetterSidebar remains optional at runtime.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { cpp } from '@codemirror/lang-cpp'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'

interface FileEntry { name: string; type: 'file' | 'directory'; path: string }
interface TextFile { path: string; text: string }
interface Project { server: string | null; configPath: string | null }
interface Location { uri: string; range: { start: { line: number; character: number } } }
interface Position { line: number; character: number }
interface Tab { path: string; text: string; server: string | null; configPath: string | null; state: string }
interface TreeLevel { entries?: readonly FileEntry[]; error?: string }

const WORKBENCH_STYLE = `
.dsh-nav-launcher{position:fixed;right:12px;top:48px;z-index:50;width:30px;height:30px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#24292f);font:16px/1 system-ui;cursor:pointer}
.dsh-nav-workbench{position:fixed;right:0;top:0;bottom:0;z-index:49;display:flex;width:min(1100px,82vw);min-width:680px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#24292f);border-left:1px solid var(--dsw-alias-border-l2,#d0d7de);font:13px/1.45 system-ui,sans-serif;box-shadow:-12px 0 32px rgba(0,0,0,.12)}
.dsh-nav-workbench *{box-sizing:border-box}.dsh-nav-workbench button,.dsh-nav-workbench input{font:inherit}.dsh-nav-workbench button{color:inherit}.dsh-nav-tree{width:252px;flex:none;display:flex;min-width:0;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1,#d8dee4);background:var(--dsw-alias-bg-layer-1,#fff)}
.dsh-nav-tree-head{display:flex;gap:6px;align-items:center;height:42px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#d8dee4)}.dsh-nav-cwd{min-width:0;flex:1;border:0;background:transparent;color:inherit;outline:none}.dsh-nav-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}.dsh-nav-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eef1f4);color:var(--dsw-alias-label-primary,#24292f)}.dsh-nav-icon:disabled{opacity:.4;cursor:default}
.dsh-nav-filter{margin:8px;border:1px solid var(--dsw-alias-border-l1,#d8dee4);border-radius:6px;padding:5px 8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none}.dsh-nav-filter:focus{border-color:var(--dsw-alias-brand-primary,#3b82f6)}.dsh-nav-tree-body{flex:1;min-height:0;overflow:auto;padding:2px 8px 10px}.dsh-nav-row{display:flex;align-items:center;gap:5px;width:100%;height:29px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left;cursor:pointer;white-space:nowrap}.dsh-nav-row:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}.dsh-nav-row-active{background:var(--dsw-alias-interactive-bg-active,#e6efff)}.dsh-nav-chev{width:13px;color:var(--dsw-alias-label-tertiary,#7a8491)}.dsh-nav-node{min-width:0;overflow:hidden;text-overflow:ellipsis}.dsh-nav-folder{font-weight:600}.dsh-nav-main{min-width:0;flex:1;display:flex;flex-direction:column}.dsh-nav-tabs{display:flex;align-items:stretch;height:34px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1,#d8dee4);background:var(--dsw-alias-bg-layer-1,#fff)}.dsh-nav-tab{display:flex;align-items:center;gap:6px;min-width:90px;max-width:180px;padding:0 5px 0 10px;border:0;border-right:1px solid var(--dsw-alias-border-l1,#d8dee4);background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}.dsh-nav-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}.dsh-nav-tab-active{background:var(--dsw-alias-interactive-bg-active,#e6efff);color:var(--dsw-alias-label-primary,#24292f)}.dsh-nav-tab-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-nav-tab-close{width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;cursor:pointer}.dsh-nav-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}
.dsh-nav-toolbar{display:flex;align-items:center;gap:6px;height:40px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#d8dee4);color:var(--dsw-alias-label-secondary,#57606a)}.dsh-nav-path{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace)}.dsh-nav-status{font-size:12px;white-space:nowrap}.dsh-nav-editor{min-height:0;flex:1}.dsh-nav-editor .cm-editor{height:100%;outline:none}.dsh-nav-editor .cm-scroller{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}.dsh-nav-editor .cm-gutters{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#7a8491)}.dsh-nav-editor .cm-activeLine,.dsh-nav-editor .cm-activeLineGutter{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}.dsh-nav-editor .cm-content{padding:10px 0}.dsh-nav-empty{display:flex;flex:1;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#7a8491)}
`

function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}
function positionAt(text: string, offset: number): Position {
  const before = text.slice(0, offset)
  return { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 }
}
function offsetAt(text: string, position: Position): number {
  const lines = text.split('\n')
  return lines.slice(0, position.line).join('\n').length + (position.line === 0 ? 0 : 1) + Math.min(position.character, lines[position.line]?.length ?? 0)
}
function language(path: string) {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (extension) {
    case 'c': case 'cc': case 'cpp': case 'cxx': case 'h': case 'hh': case 'hpp': case 'hxx': return cpp()
    case 'js': case 'mjs': case 'cjs': case 'jsx': return javascript({ jsx: true })
    case 'ts': case 'mts': case 'cts': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'py': case 'pyw': return python()
    case 'json': case 'jsonc': return json()
    case 'yml': case 'yaml': return yaml()
    default: return null
  }
}
const codeTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', color: 'var(--dsw-alias-label-primary,#24292f)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--dsw-alias-state-business-tertiary,#cfe1ff)' },
})
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: '#7a8491', fontStyle: 'italic' }, { tag: tags.keyword, color: '#9b59b6' },
  { tag: tags.string, color: '#2f8f4e' }, { tag: tags.number, color: '#ae6b00' }, { tag: tags.typeName, color: '#9b6a00' },
  { tag: tags.function(tags.variableName), color: '#1674c5' }, { tag: tags.variableName, color: '#c23a4c' },
]))

async function api<T>(method: string, cwd: string, path: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/code-navigator/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, path, ...extra }) })
  const payload = await response.json() as { ok: boolean; value?: T; error?: string }
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? `code navigator ${method} failed`)
  return payload.value as T
}

function CodeEditor(props: { tab: Tab; navigationTarget: Position | undefined; onChange(text: string): void; onDefinition(position: Position): void }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const { tab, navigationTarget, onChange, onDefinition } = props
  const changeRef = useRef(onChange)
  const definitionRef = useRef(onDefinition)
  changeRef.current = onChange
  definitionRef.current = onDefinition
  useEffect(() => {
    if (host.current === null) return
    const state = EditorState.create({
      doc: tab.text,
      extensions: [codeTheme, highlight, lineNumbers(), history(), EditorView.lineWrapping, EditorView.contentAttributes.of({ spellcheck: 'false' }), ...(language(tab.path) === null ? [] : [language(tab.path)!]), keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of(update => { if (update.docChanged) changeRef.current(update.state.doc.toString()) }),
        EditorView.domEventHandlers({
          mousemove(event, current) { current.dom.style.cursor = event.metaKey || event.ctrlKey ? 'pointer' : ''; return false },
          mouseleave(_event, current) { current.dom.style.cursor = ''; return false },
          mousedown(event, current) {
            if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false
            const offset = current.posAtCoords({ x: event.clientX, y: event.clientY })
            if (offset === null) return false
            event.preventDefault()
            definitionRef.current(positionAt(current.state.doc.toString(), offset))
            return true
          },
          keydown(event, current) {
            if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return false
            event.preventDefault()
            definitionRef.current(positionAt(current.state.doc.toString(), current.state.selection.main.head))
            return true
          },
        }),
      ],
    })
    const next = new EditorView({ state, parent: host.current })
    view.current = next
    return () => { next.destroy(); view.current = null }
  }, [tab.path])
  useEffect(() => {
    const current = view.current
    if (current === null || current.state.doc.toString() === tab.text) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: tab.text } })
  }, [tab.text])
  useEffect(() => {
    const current = view.current
    if (current === null || navigationTarget === undefined) return
    const offset = offsetAt(current.state.doc.toString(), navigationTarget)
    current.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'center' }) })
    current.focus()
  }, [navigationTarget])
  return <div className="dsh-nav-editor" ref={host} />
}

function Tree(props: { cwd: string; levels: ReadonlyMap<string, TreeLevel>; expanded: ReadonlySet<string>; activePath: string | undefined; filter: string; onToggle(path: string): void; onOpen(path: string): void }) {
  const { cwd, levels, expanded, activePath, filter, onToggle, onOpen } = props
  const render = (directory: string, depth: number): JSX.Element[] => {
    const entries = levels.get(directory)?.entries ?? []
    return entries.filter(entry => filter === '' || entry.name.toLowerCase().includes(filter.toLowerCase())).flatMap(entry => {
      const open = expanded.has(entry.path)
      const row = <button key={entry.path} type="button" className={`dsh-nav-row ${activePath === entry.path ? 'dsh-nav-row-active' : ''}`} style={{ paddingLeft: 7 + depth * 16 }} onClick={() => entry.type === 'directory' ? onToggle(entry.path) : onOpen(entry.path)}>
        <span className="dsh-nav-chev">{entry.type === 'directory' ? (open ? '⌄' : '›') : '·'}</span><span className={`dsh-nav-node ${entry.type === 'directory' ? 'dsh-nav-folder' : ''}`}>{entry.name}</span>
      </button>
      return entry.type === 'directory' && open ? [row, ...render(entry.path, depth + 1)] : [row]
    })
  }
  return <>{levels.get(cwd)?.error !== undefined ? <div className="dsh-nav-empty">{levels.get(cwd)?.error}</div> : render(cwd, 0)}</>
}

function Workbench() {
  const [open, setOpen] = useState(true)
  const [cwd, setCwd] = useState(() => localStorage.getItem('dsh-code-navigator:cwd') ?? '')
  const [levels, setLevels] = useState<Map<string, TreeLevel>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [filter, setFilter] = useState('')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activePath, setActivePath] = useState<string>()
  const [history, setHistory] = useState<Array<{ path: string; position: Position }>>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [navigationTarget, setNavigationTarget] = useState<Position>()
  const timers = useRef(new Map<string, number>())
  const tabsRef = useRef<Tab[]>([])
  tabsRef.current = tabs
  const active = tabs.find(tab => tab.path === activePath)
  const loadDirectory = useCallback(async (path: string) => {
    if (cwd === '') return
    setLevels(previous => new Map(previous).set(path, {}))
    try { const entries = await api<readonly FileEntry[]>('list', cwd, path); setLevels(previous => new Map(previous).set(path, { entries })) }
    catch (error) { setLevels(previous => new Map(previous).set(path, { error: error instanceof Error ? error.message : String(error) })) }
  }, [cwd])
  const resetWorkspace = (): void => {
    if (cwd === '') return
    localStorage.setItem('dsh-code-navigator:cwd', cwd)
    setTabs([]); setActivePath(undefined); setHistory([]); setHistoryIndex(-1); setExpanded(new Set()); setLevels(new Map())
    void loadDirectory(cwd)
  }
  const toggle = (path: string): void => {
    setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else { next.add(path); if (!levels.has(path)) void loadDirectory(path) }; return next })
  }
  const openFile = async (path: string, position?: Position): Promise<void> => {
    const existing = tabs.find(tab => tab.path === path)
    if (existing !== undefined) { setActivePath(path); setNavigationTarget(position); return }
    try {
      const [file, project] = await Promise.all([api<TextFile>('read', cwd, path), api<Project>('project', cwd, path)])
      const tab: Tab = { path: file.path, text: file.text, server: project.server, configPath: project.configPath, state: project.server === null ? 'Plain text' : 'Starting LSP…' }
      setTabs(previous => [...previous, tab]); setActivePath(file.path)
      if (project.server !== null) await api('open', cwd, file.path)
      setTabs(previous => previous.map(item => item.path === file.path ? { ...item, state: project.server === null ? 'Plain text' : 'LSP · Ready' } : item))
      if (position !== undefined) window.setTimeout(() => { setNavigationTarget(position) })
    } catch (error) {
      const state = error instanceof Error ? error.message : String(error)
      setTabs(previous => previous.some(tab => tab.path === path)
        ? previous.map(tab => tab.path === path ? { ...tab, state } : tab)
        : [...previous, { path, text: '', server: null, configPath: null, state }])
      setActivePath(path)
    }
  }
  const closeTab = (path: string): void => {
    const timer = timers.current.get(path); if (timer !== undefined) window.clearTimeout(timer)
    const tab = tabs.find(item => item.path === path)
    if (tab?.server !== null) void api('close', cwd, path).catch(console.error)
    const rest = tabs.filter(item => item.path !== path)
    setTabs(rest)
    if (activePath === path) setActivePath(rest.at(-1)?.path)
  }
  const change = (text: string): void => {
    if (active === undefined) return
    setTabs(previous => previous.map(tab => tab.path === active.path ? { ...tab, text, state: tab.server === null ? 'Plain text' : 'LSP · Updating…' } : tab))
    if (active.server === null) return
    const prior = timers.current.get(active.path); if (prior !== undefined) window.clearTimeout(prior)
    timers.current.set(active.path, window.setTimeout(() => { void api('change', cwd, active.path, { text }).then(() => setTabs(previous => previous.map(tab => tab.path === active.path ? { ...tab, state: 'LSP · Ready' } : tab))).catch(error => setTabs(previous => previous.map(tab => tab.path === active.path ? { ...tab, state: String(error) } : tab))) }, 120))
  }
  const definition = (position: Position): void => {
    if (active === undefined || active.server === null) return
    void api<readonly Location[]>('definition', cwd, active.path, { position }).then(locations => {
      const target = locations[0]
      if (target === undefined) { setTabs(previous => previous.map(tab => tab.path === active.path ? { ...tab, state: 'No definition found' } : tab)); return }
      const destination = { path: decodeURIComponent(new URL(target.uri).pathname), position: target.range.start }
      setHistory(previous => [...previous.slice(0, historyIndex + 1), { path: active.path, position }, destination]); setHistoryIndex(historyIndex + 2)
      void openFile(destination.path, destination.position)
    }).catch(error => setTabs(previous => previous.map(tab => tab.path === active.path ? { ...tab, state: String(error) } : tab)))
  }
  const move = (delta: -1 | 1): void => {
    const entry = history[historyIndex + delta]; if (entry === undefined) return
    setHistoryIndex(historyIndex + delta); void openFile(entry.path, entry.position)
  }
  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
    for (const tab of tabsRef.current) if (tab.server !== null) void api('close', cwd, tab.path).catch(console.error)
  }, [cwd])
  return <>{!open && <button className="dsh-nav-launcher" title="Code Navigator" onClick={() => setOpen(true)}>⌘</button>}{open && <div className="dsh-nav-workbench" data-dsh-code-navigator-workbench="">
    <aside className="dsh-nav-tree"><div className="dsh-nav-tree-head"><input className="dsh-nav-cwd" value={cwd} placeholder="Workspace path" onChange={event => setCwd(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') resetWorkspace() }} /><button className="dsh-nav-icon" title="Open workspace" onClick={resetWorkspace}>↵</button><button className="dsh-nav-icon" title="Close navigator" onClick={() => setOpen(false)}>×</button></div><input className="dsh-nav-filter" placeholder="Filter files" value={filter} onChange={event => setFilter(event.target.value)} /><div className="dsh-nav-tree-body"><Tree cwd={cwd} levels={levels} expanded={expanded} activePath={activePath} filter={filter} onToggle={toggle} onOpen={path => { void openFile(path) }} /></div></aside>
    <main className="dsh-nav-main"><div className="dsh-nav-tabs">{tabs.map(tab => <div key={tab.path} className={`dsh-nav-tab ${tab.path === activePath ? 'dsh-nav-tab-active' : ''}`} title={tab.path} onClick={() => setActivePath(tab.path)}><span className="dsh-nav-tab-title">{fileName(tab.path)}</span><button type="button" className="dsh-nav-tab-close" aria-label={`Close ${fileName(tab.path)}`} onClick={event => { event.stopPropagation(); closeTab(tab.path) }}>×</button></div>)}</div><div className="dsh-nav-toolbar"><button className="dsh-nav-icon" title="Go Back" disabled={historyIndex <= 0} onClick={() => move(-1)}>←</button><button className="dsh-nav-icon" title="Go Forward" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => move(1)}>→</button><span className="dsh-nav-path">{active?.path ?? 'Choose a file from the workspace'}</span><span className="dsh-nav-status">{active?.state ?? ''}</span></div>{active === undefined ? <div className="dsh-nav-empty">Open a workspace, then choose a source file.</div> : <CodeEditor tab={active} navigationTarget={navigationTarget} onChange={change} onDefinition={definition} />}</main>
  </div>}</>
}

/** Mount the styled independent workbench and remove its React root on disposal. */
export function mountNavigatorWorkbench(): () => void {
  const host = document.createElement('div')
  host.dataset.dshCodeNavigatorWorkbenchHost = ''
  const style = document.createElement('style')
  style.textContent = WORKBENCH_STYLE
  document.head.append(style)
  document.body.append(host)
  const root = createRoot(host)
  root.render(<Workbench />)
  return () => { root.unmount(); host.remove(); style.remove() }
}
