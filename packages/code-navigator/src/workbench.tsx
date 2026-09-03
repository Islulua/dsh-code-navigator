/**
 * Independent code-navigation workbench. It reuses the Sidebar's CodeMirror
 * editor model and token-driven visual language, but owns its own tabs and
 * file tree so BetterSidebar remains optional at runtime.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
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
import {
  VscArrowLeft, VscArrowRight, VscChevronDown, VscChevronRight, VscClose, VscCode,
  VscFile, VscFolder, VscFolderOpened, VscGoToFile, VscRefresh, VscSearch,
} from 'react-icons/vsc'
import { rankQuickOpenFiles } from './quick-open.ts'

interface FileEntry { name: string; type: 'file' | 'directory'; path: string }
interface TextFile { path: string; text: string }
interface Project { server: string | null; configPath: string | null }
interface Location { uri: string; range: { start: { line: number; character: number } } }
interface Position { line: number; character: number }
interface Tab { path: string; text: string; server: string | null; configPath: string | null; state: string }
interface TreeLevel { entries?: readonly FileEntry[]; error?: string; loading?: boolean }
interface BreadcrumbSegment { label: string; path: string; directory: boolean }
interface TabMenu { path: string; x: number; y: number }
interface PathMenu { directory: string; x: number; y: number; entries?: readonly FileEntry[]; error?: string; loading: boolean }
interface FileIndex { files: readonly string[]; truncated: boolean }

/** Current-session workspace feed supplied by the DSH client runtime. */
export interface NavigatorWorkspaceSource {
  getSnapshot(): string
  subscribe(listener: () => void): () => void
}

const WORKBENCH_STYLE = `
.dsh-nav-launcher{position:fixed;right:12px;top:48px;z-index:50;width:30px;height:30px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#24292f);font:16px/1 system-ui;cursor:pointer}
.dsh-nav-workbench{position:fixed;right:0;top:0;bottom:0;z-index:49;display:flex;width:min(1100px,82vw);min-width:680px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#24292f);border-left:1px solid var(--dsw-alias-border-l2,#d0d7de);font:13px/1.45 system-ui,sans-serif;box-shadow:-12px 0 32px rgba(0,0,0,.12)}
.dsh-nav-workbench *{box-sizing:border-box}.dsh-nav-workbench button,.dsh-nav-workbench input{font:inherit}.dsh-nav-workbench button{color:inherit}.dsh-nav-workbench svg{flex:none}.dsh-nav-tree{width:272px;flex:none;display:flex;min-width:0;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1,#d8dee4);background:var(--dsw-alias-bg-layer-1,#fff)}
.dsh-nav-tree-head{display:flex;gap:6px;align-items:center;height:36px;padding:0 8px 0 12px}.dsh-nav-tree-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-strong-12,600 12px system-ui);letter-spacing:.04em}.dsh-nav-workspace-row{display:flex;gap:6px;margin:0 8px 6px;padding:0 5px;border:1px solid var(--dsw-alias-border-l1,#d8dee4);border-radius:6px;background:var(--dsw-alias-bg-base,#fff)}.dsh-nav-cwd{min-width:0;flex:1;border:0;background:transparent;color:inherit;outline:none}.dsh-nav-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}.dsh-nav-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eef1f4);color:var(--dsw-alias-label-primary,#24292f)}.dsh-nav-icon:disabled{opacity:.4;cursor:default}
.dsh-nav-filter{margin:0 8px 8px;border:1px solid var(--dsw-alias-border-l1,#d8dee4);border-radius:6px;padding:5px 8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none}.dsh-nav-filter:focus{border-color:var(--dsw-alias-brand-primary,#3b82f6)}.dsh-nav-tree-body{flex:1;min-height:0;overflow:auto;padding:2px 8px 10px}.dsh-nav-row{display:flex;align-items:center;gap:6px;width:100%;height:34px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;white-space:nowrap}.dsh-nav-row:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}.dsh-nav-row-active{background:var(--dsw-alias-interactive-bg-active,#e6efff)}.dsh-nav-chev{display:inline-flex;width:14px;color:var(--dsw-alias-label-tertiary,#7a8491)}.dsh-nav-kind{display:inline-flex;width:16px;color:var(--dsw-alias-label-secondary,#57606a)}.dsh-nav-node{min-width:0;overflow:hidden;text-overflow:ellipsis}.dsh-nav-folder{font-weight:600}.dsh-nav-loading{padding:10px;color:var(--dsw-alias-label-tertiary,#7a8491)}.dsh-nav-main{min-width:0;flex:1;display:flex;flex-direction:column}.dsh-nav-tabs{display:flex;align-items:stretch;height:34px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1,#d8dee4);background:var(--dsw-alias-bg-layer-1,#fff)}.dsh-nav-tab{display:flex;align-items:center;gap:6px;min-width:90px;max-width:180px;padding:0 5px 0 10px;border:0;border-right:1px solid var(--dsw-alias-border-l1,#d8dee4);background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}.dsh-nav-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}.dsh-nav-tab-active{background:var(--dsw-alias-interactive-bg-active,#e6efff);color:var(--dsw-alias-label-primary,#24292f)}.dsh-nav-tab-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-nav-tab-close{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;cursor:pointer}.dsh-nav-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}
.dsh-nav-toolbar{display:flex;align-items:center;gap:4px;height:40px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#d8dee4);color:var(--dsw-alias-label-secondary,#57606a)}.dsh-nav-breadcrumb{display:flex;min-width:0;flex:1;align-items:center;overflow:hidden;white-space:nowrap}.dsh-nav-crumb{display:inline-flex;min-width:0;align-items:center}.dsh-nav-crumb-button{min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:4px;padding:2px 4px;background:transparent;cursor:pointer}.dsh-nav-crumb-button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f4);color:var(--dsw-alias-label-primary,#24292f)}.dsh-nav-crumb-file{min-width:0;overflow:hidden;text-overflow:ellipsis;padding:2px 4px;color:var(--dsw-alias-label-primary,#24292f);font-weight:600}.dsh-nav-crumb-separator{color:var(--dsw-alias-label-tertiary,#7a8491)}.dsh-nav-status{font-size:12px;white-space:nowrap}.dsh-nav-editor{min-height:0;flex:1}.dsh-nav-editor .cm-editor{height:100%;outline:none}.dsh-nav-editor .cm-scroller{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}.dsh-nav-editor .cm-gutters{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#7a8491)}.dsh-nav-editor .cm-activeLine,.dsh-nav-editor .cm-activeLineGutter{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}.dsh-nav-editor .cm-content{padding:10px 0}.dsh-nav-empty{display:flex;flex:1;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#7a8491)}
.dsh-nav-menu{position:fixed;z-index:10000;min-width:176px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#24292f);box-shadow:0 8px 24px rgba(0,0,0,.16);font:13px/1.4 system-ui,sans-serif}.dsh-nav-menu button{display:flex;width:100%;align-items:center;gap:8px;height:30px;padding:0 10px;border:0;border-radius:5px;background:transparent;text-align:left;cursor:pointer}.dsh-nav-menu button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}.dsh-nav-menu button:disabled{opacity:.45;cursor:default}.dsh-nav-path-menu{width:280px;max-width:min(360px,calc(100vw - 16px));max-height:320px;overflow:auto}.dsh-nav-path-menu-head{padding:5px 8px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1,#d8dee4);color:var(--dsw-alias-label-tertiary,#7a8491);font-size:11px}.dsh-nav-path-menu-state{padding:10px;color:var(--dsw-alias-label-tertiary,#7a8491)}.dsh-nav-path-menu-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-nav-quick-shade{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.08)}.dsh-nav-quick{position:absolute;top:10vh;left:50%;width:min(620px,calc(100vw - 32px));transform:translateX(-50%);overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#24292f);box-shadow:0 16px 48px rgba(0,0,0,.24);font:13px/1.4 system-ui,sans-serif}.dsh-nav-quick-input-row{display:flex;align-items:center;gap:9px;margin:8px;border:1px solid var(--dsw-alias-brand-primary,#3b82f6);border-radius:6px;padding:0 10px;box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 18%,transparent)}.dsh-nav-quick-input{height:34px;min-width:0;flex:1;border:0;outline:0;background:transparent;color:inherit;font:14px/1.4 system-ui,sans-serif}.dsh-nav-quick-results{max-height:min(430px,60vh);overflow:auto;padding:0 5px 5px}.dsh-nav-quick-row{display:grid;width:100%;grid-template-columns:18px minmax(100px,auto) minmax(0,1fr);align-items:center;gap:8px;height:34px;padding:0 8px;border:0;border-radius:5px;background:transparent;text-align:left;cursor:pointer}.dsh-nav-quick-row:hover,.dsh-nav-quick-row-active{background:var(--dsw-alias-interactive-bg-active,#e6efff)}.dsh-nav-quick-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.dsh-nav-quick-directory{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#7a8491);font-size:12px}.dsh-nav-quick-state{padding:14px;color:var(--dsw-alias-label-tertiary,#7a8491)}.dsh-nav-quick-foot{padding:5px 12px;border-top:1px solid var(--dsw-alias-border-l1,#d8dee4);color:var(--dsw-alias-label-tertiary,#7a8491);font-size:11px}
`

function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}
function breadcrumbSegments(path: string, workspace: string): readonly BreadcrumbSegment[] {
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const root = workspace.replace(/[\\/]+$/, '')
  if (root !== '' && (path === root || path.startsWith(`${root}${separator}`))) {
    const relative = path.slice(root.length).replace(/^[\\/]+/, '')
    const parts = relative === '' ? [] : relative.split(/[\\/]+/)
    let current = root
    return [{ label: fileName(root), path: root, directory: parts.length > 0 }, ...parts.map((part, index) => {
      current += `${separator}${part}`
      return { label: part, path: current, directory: index < parts.length - 1 }
    })]
  }
  const parts = path.split(/[\\/]+/).filter(Boolean)
  let current = path.startsWith(separator) ? separator : ''
  return parts.map((part, index) => {
    current = current === separator ? `${current}${part}` : current === '' ? part : `${current}${separator}${part}`
    return { label: part, path: current, directory: index < parts.length - 1 }
  })
}
function relativePath(path: string, workspace: string): string {
  const root = workspace.replace(/[\\/]+$/, '')
  const relative = path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path.slice(root.length + 1) : path
  return relative.replaceAll('\\', '/')
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
    let hovered: HTMLElement | undefined
    let savedStyle: { textDecoration: string; textUnderlineOffset: string; cursor: string } | undefined
    let lastTarget: EventTarget | null = null
    const clearHover = (): void => {
      if (hovered === undefined || savedStyle === undefined) return
      hovered.style.textDecoration = savedStyle.textDecoration
      hovered.style.textUnderlineOffset = savedStyle.textUnderlineOffset
      hovered.style.cursor = savedStyle.cursor
      hovered = undefined
      savedStyle = undefined
    }
    const updateHover = (target: EventTarget | null, modified: boolean): void => {
      lastTarget = target
      if (!modified || !(target instanceof Element)) { clearHover(); return }
      const candidate = target.closest('.cm-line span')
      if (!(candidate instanceof HTMLElement) || !next.dom.contains(candidate)) { clearHover(); return }
      if (candidate === hovered) return
      clearHover()
      hovered = candidate
      savedStyle = { textDecoration: candidate.style.textDecoration, textUnderlineOffset: candidate.style.textUnderlineOffset, cursor: candidate.style.cursor }
      candidate.style.textDecoration = 'underline'
      candidate.style.textUnderlineOffset = '2px'
      candidate.style.cursor = 'pointer'
    }
    const mousemove = (event: MouseEvent): void => { updateHover(event.target, event.metaKey || event.ctrlKey) }
    const modifierChange = (event: KeyboardEvent): void => { updateHover(lastTarget, event.metaKey || event.ctrlKey) }
    const mouseleave = (): void => { lastTarget = null; clearHover() }
    next.dom.addEventListener('mousemove', mousemove)
    next.dom.addEventListener('mouseleave', mouseleave)
    window.addEventListener('keydown', modifierChange)
    window.addEventListener('keyup', modifierChange)
    return () => {
      clearHover()
      next.dom.removeEventListener('mousemove', mousemove)
      next.dom.removeEventListener('mouseleave', mouseleave)
      window.removeEventListener('keydown', modifierChange)
      window.removeEventListener('keyup', modifierChange)
      next.destroy()
      view.current = null
    }
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
    const level = levels.get(directory)
    if (level?.loading === true) return [<div key={`${directory}:loading`} className="dsh-nav-loading" style={{ paddingLeft: 10 + depth * 16 }}>Loading…</div>]
    const entries = [...(level?.entries ?? [])].sort((left, right) => Number(left.type === 'file') - Number(right.type === 'file') || left.name.localeCompare(right.name))
    return entries.filter(entry => filter === '' || entry.name.toLowerCase().includes(filter.toLowerCase())).flatMap(entry => {
      const open = expanded.has(entry.path)
      const row = <button key={entry.path} type="button" className={`dsh-nav-row ${activePath === entry.path ? 'dsh-nav-row-active' : ''}`} style={{ paddingLeft: 7 + depth * 16 }} onClick={() => entry.type === 'directory' ? onToggle(entry.path) : onOpen(entry.path)}>
        <span className="dsh-nav-chev">{entry.type === 'directory' ? (open ? <VscChevronDown /> : <VscChevronRight />) : null}</span><span className="dsh-nav-kind">{entry.type === 'directory' ? (open ? <VscFolderOpened /> : <VscFolder />) : <VscFile />}</span><span className={`dsh-nav-node ${entry.type === 'directory' ? 'dsh-nav-folder' : ''}`}>{entry.name}</span>
      </button>
      return entry.type === 'directory' && open ? [row, ...render(entry.path, depth + 1)] : [row]
    })
  }
  const root = levels.get(cwd)
  if (cwd === '') return <div className="dsh-nav-loading">No workspace selected.</div>
  if (root?.error !== undefined) return <div className="dsh-nav-loading">{root.error}</div>
  if (root === undefined || root.loading === true) return <div className="dsh-nav-loading">Loading workspace files…</div>
  if ((root.entries?.length ?? 0) === 0) return <div className="dsh-nav-loading">This workspace contains no files.</div>
  return <>{render(cwd, 0)}</>
}

function Workbench(props: { workspaceSource: NavigatorWorkspaceSource }) {
  const sessionCwd = useSyncExternalStore(props.workspaceSource.subscribe, props.workspaceSource.getSnapshot, props.workspaceSource.getSnapshot)
  const storedCwd = localStorage.getItem('dsh-code-navigator:cwd') ?? ''
  const initialCwd = sessionCwd || storedCwd
  const [open, setOpen] = useState(true)
  const [cwdInput, setCwdInput] = useState(initialCwd)
  const [workspace, setWorkspace] = useState(initialCwd)
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const [levels, setLevels] = useState<Map<string, TreeLevel>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [filter, setFilter] = useState('')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activePath, setActivePath] = useState<string>()
  const [history, setHistory] = useState<Array<{ path: string; position: Position }>>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [navigationTarget, setNavigationTarget] = useState<Position>()
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null)
  const [pathMenu, setPathMenu] = useState<PathMenu | null>(null)
  const [quickOpenVisible, setQuickOpenVisible] = useState(false)
  const [quickOpenQuery, setQuickOpenQuery] = useState('')
  const [quickOpenSelection, setQuickOpenSelection] = useState(0)
  const [fileIndex, setFileIndex] = useState<FileIndex>()
  const [fileIndexLoading, setFileIndexLoading] = useState(false)
  const [fileIndexError, setFileIndexError] = useState<string>()
  const timers = useRef(new Map<string, number>())
  const pathRequest = useRef(0)
  const fileIndexRequest = useRef(0)
  const quickOpenInput = useRef<HTMLInputElement>(null)
  const tabsRef = useRef<Tab[]>([])
  const workspaceRef = useRef(workspace)
  tabsRef.current = tabs
  workspaceRef.current = workspace
  const active = tabs.find(tab => tab.path === activePath)
  const loadDirectory = useCallback(async (path: string) => {
    if (workspace === '') return
    setLevels(previous => new Map(previous).set(path, { loading: true }))
    try { const entries = await api<readonly FileEntry[]>('list', workspace, path); setLevels(previous => new Map(previous).set(path, { entries })) }
    catch (error) { setLevels(previous => new Map(previous).set(path, { error: error instanceof Error ? error.message : String(error) })) }
  }, [workspace])
  const loadFileIndex = useCallback(async () => {
    if (workspace === '') return
    const request = ++fileIndexRequest.current
    setFileIndexLoading(true)
    setFileIndexError(undefined)
    try {
      const next = await api<FileIndex>('files', workspace, workspace)
      if (fileIndexRequest.current === request) setFileIndex(next)
    } catch (error) {
      if (fileIndexRequest.current === request) setFileIndexError(error instanceof Error ? error.message : String(error))
    } finally {
      if (fileIndexRequest.current === request) setFileIndexLoading(false)
    }
  }, [workspace])
  const resetWorkspace = (requested = cwdInput): void => {
    const next = requested.trim()
    if (next === '') return
    for (const timer of timers.current.values()) window.clearTimeout(timer)
    timers.current.clear()
    for (const tab of tabsRef.current) if (tab.server !== null) void api('close', workspaceRef.current, tab.path).catch(console.error)
    localStorage.setItem('dsh-code-navigator:cwd', next)
    setCwdInput(next)
    setWorkspace(next)
    setWorkspaceRevision(revision => revision + 1)
    fileIndexRequest.current += 1
    setTabs([]); setActivePath(undefined); setHistory([]); setHistoryIndex(-1); setExpanded(new Set()); setLevels(new Map()); setFileIndex(undefined); setFileIndexError(undefined); setQuickOpenVisible(false)
  }
  useEffect(() => { if (workspace !== '') { void loadDirectory(workspace); void loadFileIndex() } }, [workspace, workspaceRevision, loadDirectory, loadFileIndex])
  useEffect(() => { if (sessionCwd !== '' && sessionCwd !== workspaceRef.current) resetWorkspace(sessionCwd) }, [sessionCwd])
  const toggle = (path: string): void => {
    setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else { next.add(path); if (!levels.has(path)) void loadDirectory(path) }; return next })
  }
  const openFile = async (path: string, position?: Position): Promise<void> => {
    const existing = tabs.find(tab => tab.path === path)
    if (existing !== undefined) { setActivePath(path); setNavigationTarget(position); return }
    try {
      const [file, project] = await Promise.all([api<TextFile>('read', workspace, path), api<Project>('project', workspace, path)])
      const tab: Tab = { path: file.path, text: file.text, server: project.server, configPath: project.configPath, state: project.server === null ? 'Plain text' : 'Starting LSP…' }
      setTabs(previous => [...previous, tab]); setActivePath(file.path)
      if (project.server !== null) await api('open', workspace, file.path)
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
    timers.current.delete(path)
    if (tab?.server != null) void api('close', workspace, path).catch(console.error)
    const rest = tabs.filter(item => item.path !== path)
    setTabs(rest)
    if (activePath === path) setActivePath(rest.at(-1)?.path)
  }
  const closeOtherTabs = (path: string): void => {
    for (const tab of tabs) {
      if (tab.path === path) continue
      const timer = timers.current.get(tab.path); if (timer !== undefined) window.clearTimeout(timer)
      timers.current.delete(tab.path)
      if (tab.server !== null) void api('close', workspace, tab.path).catch(console.error)
    }
    setTabs(previous => previous.filter(tab => tab.path === path))
    setActivePath(path)
  }
  const closeAllTabs = (): void => {
    for (const tab of tabs) {
      const timer = timers.current.get(tab.path); if (timer !== undefined) window.clearTimeout(timer)
      timers.current.delete(tab.path)
      if (tab.server !== null) void api('close', workspace, tab.path).catch(console.error)
    }
    setTabs([])
    setActivePath(undefined)
  }
  const browsePath = (directory: string, x: number, y: number): void => {
    const request = ++pathRequest.current
    setPathMenu({ directory, x, y, loading: true })
    void api<readonly FileEntry[]>('list', workspace, directory).then(entries => {
      if (pathRequest.current === request) setPathMenu({ directory, x, y, entries, loading: false })
    }).catch(error => {
      if (pathRequest.current === request) setPathMenu({ directory, x, y, error: error instanceof Error ? error.message : String(error), loading: false })
    })
  }
  const change = (text: string): void => {
    if (active === undefined) return
    setTabs(previous => previous.map(tab => tab.path === active.path ? { ...tab, text, state: tab.server === null ? 'Plain text' : 'LSP · Updating…' } : tab))
    if (active.server === null) return
    const prior = timers.current.get(active.path); if (prior !== undefined) window.clearTimeout(prior)
    timers.current.set(active.path, window.setTimeout(() => { void api('change', workspace, active.path, { text }).then(() => setTabs(previous => previous.map(tab => tab.path === active.path ? { ...tab, state: 'LSP · Ready' } : tab))).catch(error => setTabs(previous => previous.map(tab => tab.path === active.path ? { ...tab, state: String(error) } : tab))) }, 120))
  }
  const definition = (position: Position): void => {
    if (active === undefined || active.server === null) return
    void api<readonly Location[]>('definition', workspace, active.path, { position }).then(locations => {
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
  const quickOpenResults = useMemo(() => rankQuickOpenFiles(fileIndex?.files ?? [], quickOpenQuery, workspace), [fileIndex, quickOpenQuery, workspace])
  const showQuickOpen = useCallback((): void => {
    if (workspaceRef.current === '') return
    setOpen(true)
    setTabMenu(null)
    setPathMenu(null)
    setQuickOpenQuery('')
    setQuickOpenSelection(0)
    setQuickOpenVisible(true)
  }, [])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'p') return
      event.preventDefault()
      event.stopPropagation()
      showQuickOpen()
    }
    window.addEventListener('keydown', shortcut, true)
    return () => { window.removeEventListener('keydown', shortcut, true) }
  }, [showQuickOpen])
  useEffect(() => {
    if (!quickOpenVisible) return
    quickOpenInput.current?.focus()
  }, [quickOpenVisible])
  useEffect(() => { setQuickOpenSelection(0) }, [quickOpenQuery, fileIndex])
  useEffect(() => {
    if (tabMenu === null && pathMenu === null) return
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-dsh-nav-overlay]') !== null) return
      setTabMenu(null)
      setPathMenu(null)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setTabMenu(null); setPathMenu(null) } }
    const blur = (): void => { setTabMenu(null); setPathMenu(null) }
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', escape)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('blur', blur)
    }
  }, [tabMenu, pathMenu])
  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
    for (const tab of tabsRef.current) if (tab.server !== null) void api('close', workspaceRef.current, tab.path).catch(console.error)
  }, [])
  const crumbs = active === undefined ? [] : breadcrumbSegments(active.path, workspace)
  const tabOverlay = tabMenu === null ? null : createPortal(<div data-dsh-nav-overlay="" className="dsh-nav-menu" role="menu" style={{ left: Math.max(8, Math.min(tabMenu.x, window.innerWidth - 192)), top: Math.max(8, Math.min(tabMenu.y, window.innerHeight - 110)) }}>
    <button type="button" role="menuitem" onClick={() => { closeTab(tabMenu.path); setTabMenu(null) }}>Close</button>
    <button type="button" role="menuitem" disabled={tabs.length <= 1} onClick={() => { closeOtherTabs(tabMenu.path); setTabMenu(null) }}>Close Others</button>
    <button type="button" role="menuitem" onClick={() => { closeAllTabs(); setTabMenu(null) }}>Close All</button>
  </div>, document.body)
  const pathEntries = [...(pathMenu?.entries ?? [])].sort((left, right) => Number(left.type === 'file') - Number(right.type === 'file') || left.name.localeCompare(right.name))
  const pathOverlay = pathMenu === null ? null : createPortal(<div data-dsh-nav-overlay="" className="dsh-nav-menu dsh-nav-path-menu" role="menu" style={{ left: Math.max(8, Math.min(pathMenu.x, window.innerWidth - 296)), top: Math.max(8, Math.min(pathMenu.y, window.innerHeight - 328)) }}>
    <div className="dsh-nav-path-menu-head" title={pathMenu.directory}>{pathMenu.directory}</div>
    {pathMenu.loading && <div className="dsh-nav-path-menu-state">Loading…</div>}
    {pathMenu.error !== undefined && <div className="dsh-nav-path-menu-state">{pathMenu.error}</div>}
    {!pathMenu.loading && pathMenu.error === undefined && pathEntries.length === 0 && <div className="dsh-nav-path-menu-state">This folder is empty.</div>}
    {pathEntries.map(entry => <button key={entry.path} type="button" role="menuitem" title={entry.path} onClick={() => {
      if (entry.type === 'directory') browsePath(entry.path, pathMenu.x, pathMenu.y)
      else { setPathMenu(null); void openFile(entry.path) }
    }}>{entry.type === 'directory' ? <VscFolder /> : <VscFile />}<span className="dsh-nav-path-menu-name">{entry.name}</span>{entry.type === 'directory' && <VscChevronRight />}</button>)}
  </div>, document.body)
  const quickOpenOverlay = !quickOpenVisible ? null : createPortal(<div className="dsh-nav-quick-shade" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setQuickOpenVisible(false) }}>
    <div className="dsh-nav-quick" role="dialog" aria-modal="true" aria-label="Quick Open">
      <div className="dsh-nav-quick-input-row"><VscSearch /><input ref={quickOpenInput} className="dsh-nav-quick-input" aria-label="Search files by name" placeholder="Search files by name" value={quickOpenQuery} onChange={event => setQuickOpenQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setQuickOpenVisible(false); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (quickOpenResults.length === 0) return
          const delta = event.key === 'ArrowDown' ? 1 : -1
          setQuickOpenSelection(previous => (previous + delta + quickOpenResults.length) % quickOpenResults.length)
          window.setTimeout(() => { document.querySelector('.dsh-nav-quick-row-active')?.scrollIntoView({ block: 'nearest' }) })
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const path = quickOpenResults[quickOpenSelection]
          if (path !== undefined) { setQuickOpenVisible(false); void openFile(path) }
        }
      }} /></div>
      <div className="dsh-nav-quick-results" role="listbox" aria-label="Workspace files">
        {fileIndexLoading && fileIndex === undefined && <div className="dsh-nav-quick-state">Indexing workspace files…</div>}
        {fileIndexError !== undefined && <div className="dsh-nav-quick-state">{fileIndexError}</div>}
        {!fileIndexLoading && fileIndexError === undefined && quickOpenResults.length === 0 && <div className="dsh-nav-quick-state">{quickOpenQuery === '' ? 'No workspace files found.' : 'No matching files.'}</div>}
        {quickOpenResults.map((path, index) => { const relative = relativePath(path, workspace); const directory = relative.slice(0, Math.max(0, relative.lastIndexOf('/'))); return <button key={path} type="button" role="option" aria-selected={index === quickOpenSelection} className={`dsh-nav-quick-row ${index === quickOpenSelection ? 'dsh-nav-quick-row-active' : ''}`} title={relative} onMouseEnter={() => setQuickOpenSelection(index)} onClick={() => { setQuickOpenVisible(false); void openFile(path) }}><VscFile /><span className="dsh-nav-quick-name">{fileName(path)}</span><span className="dsh-nav-quick-directory">{directory}</span></button> })}
      </div>
      <div className="dsh-nav-quick-foot">{fileIndexLoading ? 'Indexing…' : `${fileIndex?.files.length ?? 0}${fileIndex?.truncated === true ? '+' : ''} files`} · ↑↓ select · Enter open · Esc close</div>
    </div>
  </div>, document.body)
  return <>{!open && <button className="dsh-nav-launcher" title="Code Navigator" aria-label="Open Code Navigator" onClick={() => setOpen(true)}><VscCode /></button>}{open && <div className="dsh-nav-workbench" data-dsh-code-navigator-workbench="">
    <aside className="dsh-nav-tree">
      <div className="dsh-nav-tree-head"><span className="dsh-nav-tree-title">EXPLORER · {fileName(workspace) || 'WORKSPACE'}</span><button className="dsh-nav-icon" title="Refresh files" disabled={workspace === ''} onClick={() => { setLevels(new Map()); setFileIndex(undefined); void loadDirectory(workspace); void loadFileIndex() }}><VscRefresh /></button><button className="dsh-nav-icon" title="Close navigator" onClick={() => setOpen(false)}><VscClose /></button></div>
      <div className="dsh-nav-workspace-row"><input className="dsh-nav-cwd" value={cwdInput} aria-label="Workspace path" placeholder="Workspace path" onChange={event => setCwdInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') resetWorkspace() }} /><button className="dsh-nav-icon" title="Open workspace" onClick={() => resetWorkspace()}><VscGoToFile /></button></div>
      <input className="dsh-nav-filter" aria-label="Filter files" placeholder="Filter files" value={filter} onChange={event => setFilter(event.target.value)} />
      <div className="dsh-nav-tree-body"><Tree cwd={workspace} levels={levels} expanded={expanded} activePath={activePath} filter={filter} onToggle={toggle} onOpen={path => { void openFile(path) }} /></div>
    </aside>
    <main className="dsh-nav-main"><div className="dsh-nav-tabs">{tabs.map(tab => <div key={tab.path} className={`dsh-nav-tab ${tab.path === activePath ? 'dsh-nav-tab-active' : ''}`} title={tab.path} onClick={() => setActivePath(tab.path)} onContextMenu={event => { event.preventDefault(); setPathMenu(null); setTabMenu({ path: tab.path, x: event.clientX, y: event.clientY }) }}><span className="dsh-nav-tab-title">{fileName(tab.path)}</span><button type="button" className="dsh-nav-tab-close" aria-label={`Close ${fileName(tab.path)}`} onClick={event => { event.stopPropagation(); closeTab(tab.path) }}><VscClose /></button></div>)}</div><div className="dsh-nav-toolbar"><button className="dsh-nav-icon" title="Go Back" disabled={historyIndex <= 0} onClick={() => move(-1)}><VscArrowLeft /></button><button className="dsh-nav-icon" title="Go Forward" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => move(1)}><VscArrowRight /></button><div className="dsh-nav-breadcrumb">{active === undefined ? <span className="dsh-nav-crumb-file">Choose a file from the workspace</span> : crumbs.map((crumb, index) => <span className="dsh-nav-crumb" key={crumb.path}>{index > 0 && <VscChevronRight className="dsh-nav-crumb-separator" />}{crumb.directory ? <button type="button" className="dsh-nav-crumb-button" title={crumb.path} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setTabMenu(null); browsePath(crumb.path, rect.left, rect.bottom + 4) }}>{crumb.label}</button> : <span className="dsh-nav-crumb-file" title={crumb.path}>{crumb.label}</span>}</span>)}</div><span className="dsh-nav-status">{active?.state ?? ''}</span></div>{active === undefined ? <div className="dsh-nav-empty">Open a workspace, then choose a source file.</div> : <CodeEditor tab={active} navigationTarget={navigationTarget} onChange={change} onDefinition={definition} />}</main>
    {tabOverlay}{pathOverlay}{quickOpenOverlay}
  </div>}</>
}

/** Mount the styled independent workbench and remove its React root on disposal. */
export function mountNavigatorWorkbench(workspaceSource: NavigatorWorkspaceSource): () => void {
  const host = document.createElement('div')
  host.dataset.dshCodeNavigatorWorkbenchHost = ''
  const style = document.createElement('style')
  style.textContent = WORKBENCH_STYLE
  document.head.append(style)
  document.body.append(host)
  const root = createRoot(host)
  root.render(<Workbench workspaceSource={workspaceSource} />)
  return () => { root.unmount(); host.remove(); style.remove() }
}
