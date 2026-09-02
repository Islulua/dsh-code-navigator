/**
 * The code/markdown file viewer: a CodeMirror 6 editor with line wrapping,
 * syntax highlighting (extension-keyed language), a dirty dot and Ctrl/Cmd+S
 * save, and a preview/edit toggle for markdown files. Registered as the
 * `code` (catch-all) and `markdown` built-in viewers; the editor tab host
 * fetches the content through the fsRead strategy and passes it in props,
 * so this component never fetches or dispatches — it only edits.
 *
 * The toolbar (mode toggle / dirty dot / save / status) renders as its own
 * row below the host's title bar, VSCode-style — unless the host passes
 * `toolbar: 'host'` (the merged editor-explorer mode), in which case this
 * component skips the row and reports state + registers commands through
 * the FileViewerProps toolbar callbacks so the host's path-input header
 * renders the controls instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { EditorState, StateEffect, StateField, type RangeSet } from '@codemirror/state'
import { Decoration, EditorView as CodeMirrorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { IconCheckOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownTextProps } from './markdown-labels.tsx'
import { api, htmlUrl, type LspLocationsResult } from './api.ts'
import { rewriteLocalImageUrls } from './markdown-images.ts'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { appendToDraft } from './conversation-draft.ts'
import { buildSelectionInsert, linesOfSelection } from './selection-payload.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { analyzeMarkdownHtml } from './markdown-html.ts'
import { LazyMermaidMarkdown, MarkdownDocument, type MarkdownHtmlMedia } from './MarkdownHtml.tsx'
import { MdToc } from './md-toc.tsx'
import { splitMermaidBlocks } from './mermaid-blocks.ts'
import { t } from './locales.ts'
import type { EditorToolbarState, FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** Previewable files (rendered output vs source editing). */
type ViewMode = 'preview' | 'edit'

/** The floating "add to conversation" action: payload + viewport anchor. */
interface SelectionPopup {
  insert: string
  left: number
  top: number
}

/** User-visible progress of the default-on language-server warm-up. */
interface LspWarmupStatus {
  phase: 'detecting' | 'loading' | 'ready' | 'failed'
  server: string
  config: string | null
  elapsedMs?: number
}

/**
 * The sandbox tokens of the HTML preview iframe. NO allow-same-origin (the
 * preview must stay in an opaque origin — with the route's own origin it
 * could read session data) and NO allow-top-navigation (a previewed page
 * must not hijack the GUI). The user can disable the sandbox per-feature
 * in the side card settings (warned); the toggle below reflects it.
 */
export const HTML_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-downloads allow-modals'

/**
 * Code navigation affordance (VSCode-style "jumpable symbol" hint).
 *
 * The identifier range under the pointer is tracked on `mousemove`. Holding
 * the jump modifier (Cmd/Ctrl) underlines it immediately; otherwise a
 * debounced, cached `goToDefinition` pre-fetch decides — the word is
 * underlined only when a definition actually exists, exactly like VSCode's
 * hover highlight. The same cache backs the Cmd/Ctrl+click jump, so a symbol
 * that was hovered already opens instantly. A warm-up query on file open
 * starts the language server and builds the file's preamble in the
 * background, removing the multi-second cold start on the first C++ jump.
 */

/** The identifier token under `pos`, or null when the pointer is not on one. */
function wordRangeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  if (pos < 0 || pos > state.doc.length) return null
  const line = state.doc.lineAt(pos)
  const text = line.text
  const rel = pos - line.from
  if (rel < 0 || rel > text.length) return null
  const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c)
  // Not on a word, and not right after one (e.g. trailing the last char).
  if (rel < text.length && !isWord(text.charAt(rel)) && !(rel > 0 && isWord(text.charAt(rel - 1)))) return null
  let from = rel
  while (from > 0 && isWord(text.charAt(from - 1))) from -= 1
  let to = rel
  while (to < text.length && isWord(text.charAt(to))) to += 1
  if (from === to) return null
  return { from: line.from + from, to: line.from + to }
}

/** Underline decoration applied to the hovered/clickable identifier. */
const NAV_UNDERLINE_MARK = Decoration.mark({ class: 'cm-nav-underline' })
/** Effect carrying the range to underline (null clears it). */
const navHoverEffect = StateEffect.define<{ from: number; to: number } | null>()
/** State field that renders the current navigation underline. */
const navHoverField = StateField.define<RangeSet<Decoration>>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(navHoverEffect)) {
        return effect.value === null
          ? Decoration.none
          : Decoration.set([NAV_UNDERLINE_MARK.range(effect.value.from, effect.value.to)])
      }
    }
    // The document changed: stale ranges are meaningless, drop the underline.
    if (tr.docChanged) return Decoration.none
    return deco
  },
  provide: (field) => CodeMirrorView.decorations.from(field),
})

export function TextEditor(props: FileViewerProps) {
  const { ctx, store, scope, path, viewerId, content, truncated, navigation } = props
  const [mode, setMode] = useState<ViewMode>('preview')
  /** The editor's current text (null while clean); preview renders this. */
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [lspWarmup, setLspWarmup] = useState<LspWarmupStatus | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | null>(null)
  const savingRef = useRef(false)
  /** The theme compartment of the current view (reconfigured on scheme flip). */
  const themeCompRef = useRef<CmThemeCompartment | null>(null)
  /** The app's resolved color scheme; the editor re-themes in place on flips. */
  const [dark, setDark] = useState(() => isDarkScheme())
  /** The floating "add to conversation" popup (viewport-anchored; null = hidden). */
  const [popup, setPopup] = useState<SelectionPopup | null>(null)
  /** Live mirror of the popup state for click-time reads (no re-render race). */
  const popupRef = useRef<SelectionPopup | null>(null)
  /** The markdown preview container (selection-containment + line lookup). */
  const mdRef = useRef<HTMLDivElement>(null)
  /** LSP definition cache: `${path}|${line}|${char}` -> result (null = no def). */
  const navCacheRef = useRef<Map<string, LspLocationsResult | null>>(new Map())
  /** Pending hover pre-fetch timer (window timeout id). */
  const navTimerRef = useRef<number | null>(null)
  /** Latest interactive lookup; newer hover/click work cancels stale work. */
  const navRequestRef = useRef<AbortController | null>(null)
  /** The identifier range currently hovered/underlined (or being checked). */
  const navHoverRangeRef = useRef<{ from: number; to: number } | null>(null)
  const subscribePrefs = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const readPreloadCompileCommands = useCallback(
    () => store.getSnapshot().prefs.preloadCompileCommands,
    [store],
  )
  const preloadCompileCommands = useSyncExternalStore(
    subscribePrefs,
    readPreloadCompileCommands,
    readPreloadCompileCommands,
  )

  const hidePopup = (): void => {
    popupRef.current = null
    setPopup(null)
  }

  /** Anchor the popup above the selection center; clamp inside the viewport. */
  const showPopup = (insert: string, left: number, top: number): void => {
    const next: SelectionPopup = {
      insert,
      left: Math.min(Math.max(left, 80), window.innerWidth - 80),
      top,
    }
    popupRef.current = next
    setPopup(next)
  }

  /** The popup button's click: insert the stored payload into the draft. */
  const commitPopup = (): void => {
    const current = popupRef.current
    if (current === null) return
    appendToDraft(ctx, scope.sessionId, current.insert)
    hidePopup()
  }

  useEffect(() => subscribeColorScheme(() => { setDark(isDarkScheme()) }), [])

  // A new file (tab switch) starts clean: fresh preview mode, no draft.
  useEffect(() => {
    setMode('preview')
    setDraft(null)
    setDirty(false)
    setSaveState('idle')
    hidePopup()
  }, [content])

  // Create the CodeMirror editor once the content is loaded. The view owns
  // the document; React only tracks dirty/draft state through the update
  // listener. For markdown the view stays mounted while previewing (hidden),
  // so unsaved edits survive the preview/edit toggle. The theme + syntax
  // colors live in a compartment so a scheme flip reconfigures only that
  // part — the document, undo history and scroll position survive.
  useEffect(() => {
    if (content === undefined) return
    const host = hostRef.current
    if (host === null) return
    const language = languageForPath(path)
    const themeComp = new CmThemeCompartment()
    themeCompRef.current = themeComp
    // Navigation-hint helpers (closure over scope/path/refs; the editor's
    // event handlers call them on mouse events).
    const clearNavHover = (view: CodeMirrorView): void => {
      if (navTimerRef.current !== null) {
        window.clearTimeout(navTimerRef.current)
        navTimerRef.current = null
      }
      navHoverRangeRef.current = null
      view.dispatch({ effects: navHoverEffect.of(null) })
    }
    const checkNavHover = (view: CodeMirrorView, range: { from: number; to: number }): void => {
      const line = view.state.doc.lineAt(range.from)
      const character = range.from - line.from
      const key = `${path}|${line.number - 1}|${character}`
      const cached = navCacheRef.current.get(key)
      if (cached !== undefined) {
        const hovered = navHoverRangeRef.current
        if (cached !== null && cached.locations.length > 0
          && hovered !== null && hovered.from === range.from && hovered.to === range.to) {
          view.dispatch({ effects: navHoverEffect.of(range) })
        }
        return
      }
      if (navTimerRef.current !== null) window.clearTimeout(navTimerRef.current)
      navTimerRef.current = window.setTimeout(() => {
        navTimerRef.current = null
        if (navHoverRangeRef.current === null || navHoverRangeRef.current.from !== range.from) return
        navRequestRef.current?.abort()
        const controller = new AbortController()
        navRequestRef.current = controller
        void api.lspDefinition(scope, path, { line: line.number - 1, character }, controller.signal)
          .then((result) => {
            navCacheRef.current.set(key, result)
            const hovered = navHoverRangeRef.current
            if (hovered === null || hovered.from !== range.from || hovered.to !== range.to) return
            view.dispatch(result.locations.length > 0
              ? { effects: navHoverEffect.of(range) }
              : { effects: navHoverEffect.of(null) })
          })
          .catch(() => { navCacheRef.current.set(key, null) })
      }, 220)
    }
    const state = EditorState.create({
      doc: content,
      extensions: [
        CodeMirrorView.lineWrapping,
        lineNumbers(),
        history(),
        EditorState.tabSize.of(2),
        CodeMirrorView.contentAttributes.of({ spellcheck: 'false' }),
        cmSurfaceTheme,
        themeComp.of(dark),
        ...(language !== null ? [language] : []),
        CodeMirrorView.updateListener.of((update) => {
          if (update.docChanged) {
            setDraft(update.state.doc.toString())
            setDirty(true)
            // Positions shifted: hover cache and any underline are stale.
            navCacheRef.current.clear()
            if (navHoverRangeRef.current !== null) {
              navHoverRangeRef.current = null
            }
          }
        }),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { save(); return true },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Selection popup (the code and markdown editors): a non-empty
        // selection anchors the floating "add to conversation" button above
        // its head. Scrolling (geometry/viewport change) or losing focus
        // hides it; typing collapses the selection and hides it too.
        ...(viewerId === 'code' || viewerId === 'markdown' ? [
          CodeMirrorView.domEventHandlers({
            click: (event, view) => {
              // Jump modifier: Cmd/Ctrl, and never with Alt/Shift (the latter
              // are the browser's own multi-select / new-tab chords).
              if (event.button !== 0 || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
              if (position === null) return false
              event.preventDefault()
              if (navTimerRef.current !== null) {
                window.clearTimeout(navTimerRef.current)
                navTimerRef.current = null
              }
              const range = wordRangeAt(view.state, position)
              const line = view.state.doc.lineAt(range !== null ? range.from : position)
              const character = range !== null ? range.from - line.from : position - line.from
              const key = `${path}|${line.number - 1}|${character}`
              const apply = (result: LspLocationsResult | null): void => {
                const target = result?.locations[0]
                if (target === undefined) return
                ctx.get('betterSidebar')?.openLocation(scope, {
                  path: target.path,
                  line: target.range.start.line,
                  character: target.range.start.character,
                }, undefined, { path, line: line.number - 1, character })
              }
              // A hover pre-fetch already resolved this symbol: jump instantly.
              const cached = navCacheRef.current.get(key)
              if (cached !== undefined) {
                apply(cached)
                return true
              }
              navRequestRef.current?.abort()
              const controller = new AbortController()
              navRequestRef.current = controller
              void api.lspDefinition(scope, path, {
                line: line.number - 1,
                character,
              }, controller.signal).then((result) => {
                navCacheRef.current.set(key, result)
                apply(result)
              }).catch((error: unknown) => {
                if (!(error instanceof DOMException && error.name === 'AbortError')) {
                  console.error('[dsh-better-sidebar] definition lookup failed:', error)
                }
              })
              return true
            },
          }),
          // Navigation hint (code viewer): hover the pointer over an
          // identifier — while holding Cmd/Ctrl it underlines immediately,
          // otherwise a debounced, cached definition check underlines it only
          // when a definition exists (VSCode-style). Leaving the editor clears
          // both the underline and any pending check.
          ...(viewerId === 'code' ? [navHoverField, CodeMirrorView.domEventHandlers({
            mousemove: (event, view) => {
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
              const range = position === null ? null : wordRangeAt(view.state, position)
              if (range === null) {
                clearNavHover(view)
                return false
              }
              const current = navHoverRangeRef.current
              if (current !== null && current.from === range.from && current.to === range.to) return false
              navHoverRangeRef.current = range
              if (event.metaKey || event.ctrlKey) {
                // Snappy affordance while the jump modifier is held; the check
                // below still removes it when the symbol has no definition.
                view.dispatch({ effects: navHoverEffect.of(range) })
              }
              checkNavHover(view, range)
              return false
            },
            mouseleave: (_event, view) => { clearNavHover(view); return false },
          })] : []),
          CodeMirrorView.updateListener.of((update) => {
            if (update.geometryChanged || update.viewportChanged) {
              hidePopup()
              return
            }
            if (!update.view.hasFocus) {
              hidePopup()
              return
            }
            if (!(update.selectionSet || update.docChanged || update.focusChanged)) return
            const sel = update.state.selection.main
            if (sel.empty) {
              hidePopup()
              return
            }
            const text = update.state.sliceDoc(sel.from, sel.to)
            if (text.trim() === '') {
              hidePopup()
              return
            }
            // Page coordinates (the document root may scroll); the popup is
            // position:fixed, so convert to viewport coordinates.
            const rect = update.view.coordsAtPos(sel.head)
            if (rect === null) {
              hidePopup()
              return
            }
            const doc = update.state.doc
            showPopup(
              buildSelectionInsert(path, scope.cwd, {
                start: doc.lineAt(sel.from).number,
                end: doc.lineAt(sel.to).number,
              }, text),
              rect.left - window.scrollX + (rect.right - rect.left) / 2,
              rect.top - window.scrollY,
            )
          }),
        ] : []),
      ],
    })
    const view = new CodeMirrorView({ state, parent: host })
    viewRef.current = view
    return () => {
      navRequestRef.current?.abort()
      navRequestRef.current = null
      view.destroy()
      viewRef.current = null
      themeCompRef.current = null
    }
    // The keymap's save() reads live refs; scope/path are stable for a
    // tab's lifetime, and the dark flip is handled by the reconfigure
    // effect below (recreating the view here would drop the draft).
  }, [content, path])

  // Default-on warm-up: the first background definition request starts the
  // pooled server, lets clangd discover compile_commands.json and builds the
  // file preamble before the user asks to jump. Users can disable it in the
  // Code viewer settings when background project I/O is undesirable.
  useEffect(() => {
    if (!preloadCompileCommands || viewerId !== 'code' || content === undefined) {
      setLspWarmup(null)
      return
    }
    const view = viewRef.current
    if (view === null) return
    const match = /[A-Za-z_][A-Za-z0-9_]*/.exec(content)
    const offset = match?.index ?? 0
    const line = view.state.doc.lineAt(offset)
    const character = offset - line.from
    const key = `${path}|${line.number - 1}|${character}`
    const controller = new AbortController()
    const started = performance.now()
    setLspWarmup({ phase: 'detecting', server: 'LSP', config: null })
    void api.lspProject(scope, path, controller.signal)
      .then(async (project) => {
        const config = project.configPath?.split(/[\\/]/).pop() ?? null
        setLspWarmup({ phase: 'loading', server: project.server, config })
        const cached = navCacheRef.current.get(key)
        const result = cached === undefined
          ? await api.lspDefinition(scope, path, { line: line.number - 1, character }, controller.signal)
          : cached
        if (result !== null) navCacheRef.current.set(key, result)
        setLspWarmup({
          phase: 'ready',
          server: project.server,
          config,
          elapsedMs: Math.round(performance.now() - started),
        })
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        navCacheRef.current.set(key, null)
        setLspWarmup({
          phase: 'failed',
          server: 'LSP',
          config: null,
          elapsedMs: Math.round(performance.now() - started),
        })
      })
    return () => { controller.abort() }
  }, [content, path, preloadCompileCommands, scope.sessionId, scope.cwd, viewerId])

  // A definition jump can target an already-open editor. Re-select and
  // center it whenever the service publishes a new navigation revision.
  useEffect(() => {
    if (navigation === undefined || navigation.path !== path) return
    const view = viewRef.current
    if (view === null || navigation.line >= view.state.doc.lines) return
    const line = view.state.doc.line(navigation.line + 1)
    const position = Math.min(line.to, line.from + navigation.character)
    view.dispatch({
      selection: { anchor: position },
      effects: CodeMirrorView.scrollIntoView(position, { y: 'center' }),
    })
    view.focus()
  }, [navigation?.revision, path])

  // Scheme flip: re-theme in place (the compartment holds only the
  // scheme-dependent extensions; everything else is untouched).
  useEffect(() => {
    const view = viewRef.current
    const themeComp = themeCompRef.current
    if (view === null || themeComp === null) return
    view.dispatch({ effects: themeComp.reconfigure(dark) })
  }, [dark])

  // The editor may have been display:none while previewing; re-measure when
  // it becomes visible again (CodeMirror sizes itself on reveal). A mode
  // flip also invalidates any anchored selection popup.
  useEffect(() => {
    hidePopup()
    if (mode === 'edit') viewRef.current?.requestMeasure()
  }, [mode])

  const save = (): void => {
    const view = viewRef.current
    if (view === null || savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    api.fsWrite(scope, path, view.state.doc.toString()).then(() => {
      savingRef.current = false
      setDraft(null)
      setDirty(false)
      setSaveState('saved')
    }).catch(() => {
      savingRef.current = false
      setSaveState('failed')
    })
  }

  const markdown = viewerId === 'markdown'
  const html = viewerId === 'html'
  /** The markdown source the preview renders (draft wins over saved content). */
  const mdText = draft ?? content ?? ''
  /** The preview source: `mdText` with local image destinations rewritten to
   *  absolute media URLs (see {@link rewriteLocalImageUrls}); the raw
   *  `mdText` stays untouched for selection/line lookup and for mermaid-block
   *  detection, which are unaffected by image syntax. */
  const previewText = markdown
    ? rewriteLocalImageUrls(mdText, scope, path, window.location.origin)
    : mdText
  /** md/mermaid block split for the preview (mermaid fences lift out). Split
   *  only in preview mode: edit-mode keystrokes must not re-scan the source. */
  const mdBlocks = useMemo(
    () => (markdown && mode === 'preview' ? splitMermaidBlocks(mdText) : []),
    [markdown, mode, mdText],
  )
  /** Raw-HTML analysis (block runs lifted out + inline gate). Non-null only
   *  for documents that actually contain HTML — plain markdown keeps the
   *  legacy single-pass render path below, byte-for-byte. */
  const htmlInfo = useMemo(
    () => (markdown && mode === 'preview' ? analyzeMarkdownHtml(mdText) : null),
    [markdown, mode, mdText],
  )
  const hasMermaid = useMemo(
    () => htmlInfo !== null
      ? htmlInfo.segments.some((segment) => segment.kind === 'markdown'
        && splitMermaidBlocks(segment.text).some((block) => block.kind === 'mermaid'))
      : mdBlocks.some((block) => block.kind === 'mermaid'),
    [htmlInfo, mdBlocks],
  )
  /** The media context for the split renderer (local-src rewriting inside
   *  sanitized HTML). Memoized on primitives: MarkdownDocument sanitizes per
   *  `media` identity, so a fresh object per render would re-sanitize every
   *  keystroke. */
  const htmlMedia = useMemo<MarkdownHtmlMedia>(
    () => ({ scope, path, origin: window.location.origin }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.sessionId, scope.cwd, path],
  )
  const codeLabels = { copyLabel: t('copy'), copiedLabel: t('copied') }

  /**
   * Selection popup for the markdown preview: a mouse-up inside the preview
   * container anchors the floating "add to conversation" button above the
   * selection. Line numbers come from a best-effort reverse-search of the
   * selected text in the source ({@link linesOfSelection} — an ambiguous or
   * missing hit omits them). The button's own mousedown preventDefaults so
   * the selection survives until the click commits.
   */
  const handlePreviewMouseUp = (): void => {
    const sel = window.getSelection()
    if (sel === null || sel.isCollapsed || sel.anchorNode === null || sel.focusNode === null) {
      hidePopup()
      return
    }
    const host = mdRef.current
    if (host === null || !host.contains(sel.anchorNode) || !host.contains(sel.focusNode)) {
      hidePopup()
      return
    }
    const text = sel.toString()
    if (text.trim() === '') {
      hidePopup()
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const lines = linesOfSelection(mdText, text)
    showPopup(
      buildSelectionInsert(path, scope.cwd, lines ?? undefined, text),
      rect.left + rect.width / 2,
      rect.top,
    )
  }
  const editable = content !== undefined
  const saveLabel = saveState === 'saving' ? t('loading') : saveState === 'saved' ? t('saved') : saveState === 'failed' ? t('saveFailed') : ''
  // Per-feature sandbox escape hatch: the global side card setting (warned)
  // plus a per-surface temporary unlock. The unlock state starts at the
  // "default unsafe" pref so a preview can open straight into the red
  // unsandboxed state (still restorable from the status row). With the
  // sandbox OFF the preview iframe drops its sandbox attribute entirely —
  // the previewed page then runs on the GUI's own origin with full session
  // access.
  const [localUnlock, setLocalUnlock] = useState(() => props.store?.getPrefs().htmlViewerDefaultUnsafe === true)
  const htmlNoSandbox = props.store?.getPrefs().htmlViewerNoSandbox === true || localUnlock

  // Host-toolbar mode (the merged editor header renders the controls): skip
  // the own toolbar row, report the state after every relevant render (the
  // JSON key guards redundant calls), and register the commands on mount.
  const hostToolbar = props.toolbar === 'host'
  const lastToolbarRef = useRef('')
  useEffect(() => {
    if (!hostToolbar) return
    const state: EditorToolbarState = { modes: markdown || html, mode, dirty, editable, saveState }
    const key = JSON.stringify(state)
    if (lastToolbarRef.current === key) return
    lastToolbarRef.current = key
    props.onToolbarState?.(state)
  })
  useEffect(() => {
    if (!hostToolbar) return
    // `save` reads live refs only, and `setMode` is the stable state setter —
    // registering this render's closures is safe for the mount's lifetime.
    props.onToolbarControls?.({ setMode, save })
    return () => { props.onToolbarControls?.(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostToolbar])

  return (
    <>
      {!hostToolbar && (
      <div className={css.editorHeader}>
        {(markdown || html) && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'preview' && css.editorModeActive)}
              onClick={() => { setMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, mode === 'edit' && css.editorModeActive)}
              onClick={() => { setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {dirty && <span className={css.dirtyDot} title={t('unsaved')} />}
        {editable && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={save}
          >
            <IconCheckOutline16 />
          </button>
        )}
        {saveLabel !== '' && <span className={clsx(css.editorStatus, saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>}
      </div>
      )}
      {editable && (
        <>
          {truncated === true && mode === 'edit' && <div className={css.editorBanner}>{t('truncation')}</div>}
          <div
            className={clsx(css.editorCm, (markdown || html) && mode === 'preview' && css.editorCmHidden)}
            ref={hostRef}
          />
        </>
      )}
      {viewerId === 'code' && lspWarmup !== null && (
        <div className={clsx(css.lspStatusBar, lspWarmup.phase === 'failed' && css.lspStatusFailed)}>
          <span className={clsx(css.lspStatusDot, (lspWarmup.phase === 'detecting' || lspWarmup.phase === 'loading') && css.lspStatusBusy)} />
          <span className={css.lspStatusText} title={[lspWarmup.server, lspWarmup.config].filter(Boolean).join(' · ')}>
            {[lspWarmup.server, lspWarmup.config].filter(Boolean).join(' · ')}
            {' · '}
            {lspWarmup.phase === 'failed'
              ? t('error')
              : lspWarmup.phase === 'ready'
                ? `✓ ${lspWarmup.elapsedMs ?? 0} ms`
                : t('loading')}
          </span>
        </div>
      )}
      {markdown && mode === 'preview' && (
        <div
          className={css.editorMd}
          ref={mdRef}
          onMouseUp={handlePreviewMouseUp}
          onScroll={hidePopup}
        >
          {/* The fence copy-button labels must come from this plugin's own
              dictionary: the DSH MarkdownText/CodeBlock are cordis-free and
              fall back to hardcoded Chinese otherwise (same pattern as the
              chat's AssistantMarkdown). Render-time t() keeps them following
              the active locale on live switches. Plain markdown (no HTML)
              renders exactly as before — one MarkdownText pass for the whole
              document, or the mermaid lazy chunk (single markdown parse;
              cross-fence references/footnotes stay intact) when a mermaid
              fence exists. Documents containing HTML (block runs or inline
              tags) render through the split document renderer: markdown runs
              keep the MarkdownText/mermaid path while raw-HTML runs render
              as sanitized DOM (see markdown-html.tsx). */}
          {/* The outline button rides on top of the preview scroll container
              (sticky, zero-height — first child so it pins from the very
              top) once the document has enough headings. */}
          <MdToc />
          {htmlInfo !== null
            ? <MarkdownDocument info={htmlInfo} media={htmlMedia} codeLabels={codeLabels} />
            : hasMermaid
              ? <LazyMermaidMarkdown text={previewText} codeLabels={codeLabels} />
              : <MarkdownText {...markdownTextProps(previewText, codeLabels)} />}
        </div>
      )}
      {html && mode === 'preview' && (
        <>
          <SandboxStatusBar
            sandboxed={!htmlNoSandbox}
            local={localUnlock}
            dangerCopy={t('htmlNoSandboxWarning')}
            onUnlock={() => { setLocalUnlock(true) }}
            onRestore={() => { setLocalUnlock(false) }}
          />
          {/* Route-src (never srcdoc — a srcdoc frame inherits the parent
              origin when unsandboxed; the route URL keeps the frame
              cross-origin by construction). The preview shows the SAVED
              file; the draft is only visible in edit mode. */}
          <iframe
            className={css.editorHtml}
            src={htmlUrl(scope, path)}
            sandbox={htmlNoSandbox ? undefined : HTML_IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            allow=""
            title={path}
          />
        </>
      )}
      {popup !== null && createPortal(
        <button
          type="button"
          className={css.selectionPopup}
          style={{ left: popup.left, top: popup.top }}
          // Keep the selection (and CodeMirror focus) alive until the click
          // commits — without this the popup unmounts before click lands.
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={commitPopup}
        >
          {t('addToConversation')}
        </button>,
        document.body,
      )}
    </>
  )
}
