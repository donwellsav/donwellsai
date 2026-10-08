import { useEffect, useRef, useState } from 'react'
import { effectiveEditorFontFamily, effectiveEditorFontSize } from '@shared/settings'
import {
  cacheEditorDocument,
  getEditorDocument,
  retainEditorDocument,
  type EditorDocument
} from '../editor-models'
import {
  captureEditorRecoveryViewState,
  getDocumentViewState,
  restoreEditorRecoveryViewState,
  saveDocumentViewState
} from '../document-view-state'
import {
  getEditorRecoveryController,
  type EditorRecoveryPersistenceStatus
} from '../editor-recovery'
import { VersionedEditorSave, type EditorSaveSnapshot } from '../editor-save'
import { monaco, registerLanguageWorkspace, restartLanguageTools } from '../monaco-setup'
import { isMarkdownFile, useAppStore } from '../store'
import { selectedGraphSymbol } from '../project-graph'
import { attachProjectLanguageTools } from '../project-language-tools'
import { MarkdownPreview } from './MarkdownPreview'
import { ModalDialog } from './ModalDialog'

const RECOVERY_CHECKPOINT_DELAY_MS = 180

/**
 * One file, one pane. Its cached Monaco model and save controller outlive pane
 * remounts so undo history, dirty text, and failed saves remain recoverable.
 */
export function EditorPane({ worktreePath, relPath }: { worktreePath: string; relPath: string }) {
  const preview = useAppStore((state) => state.previews[worktreePath]?.[relPath])
  const navigation = useAppStore((state) => state.documentNavigation[worktreePath]?.[relPath])
  const settings = useAppStore((state) => state.settings)
  const openPreview = useAppStore((state) => state.openPreview)
  const markdown = isMarkdownFile(relPath)
  const mode = markdown ? preview?.mode ?? 'edit' : 'edit'
  const recovery = getEditorRecoveryController()
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const documentRef = useRef<EditorDocument | null>(null)
  const applyingModelChange = useRef(false)
  const saveTimerRef = useRef<number | undefined>(undefined)
  const recoveryTimerRef = useRef<number | undefined>(undefined)
  const autoSaveRef = useRef({ mode: settings.editorAutoSaveMode, delay: settings.editorAutoSaveDelayMs })
  const [saveState, setSaveState] = useState<EditorSaveSnapshot | null>(null)
  const [recoveryStatus, setRecoveryStatus] = useState<EditorRecoveryPersistenceStatus>({ phase: 'idle' })
  const [reloadConfirmationOpen, setReloadConfirmationOpen] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [comparison, setComparison] = useState<{ disk: string; buffer: string } | null>(null)
  const comparisonHost = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!comparison || !comparisonHost.current) return
    const original = monaco.editor.createModel(comparison.disk)
    const modified = monaco.editor.createModel(comparison.buffer)
    const editor = monaco.editor.createDiffEditor(comparisonHost.current, { readOnly: true, automaticLayout: true, originalEditable: false, originalAriaLabel: 'Current disk snapshot', modifiedAriaLabel: 'Unsaved editor snapshot' })
    editor.setModel({ original, modified })
    return () => { editor.dispose(); original.dispose(); modified.dispose() }
  }, [comparison])
  const [reloadError, setReloadError] = useState<string | null>(null)
  const [editorMountError, setEditorMountError] = useState<string | null>(null)
  const [mountAttempt, setMountAttempt] = useState(0)
  const [previewRetrying, setPreviewRetrying] = useState(false)
  const [previewOpenError, setPreviewOpenError] = useState<string | null>(null)
  autoSaveRef.current = { mode: settings.editorAutoSaveMode, delay: settings.editorAutoSaveDelayMs }

  const scheduleAutoSave = (): void => {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = undefined
    if (autoSaveRef.current.mode !== 'after-delay') return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined
      const editorDocument = getEditorDocument(worktreePath, relPath)
      if (editorDocument) void editorDocument.save.flush()
    }, autoSaveRef.current.delay)
  }

  const persistRecoveryCheckpoint = (
    editorDocument: EditorDocument,
    editor: monaco.editor.IStandaloneCodeEditor | null
  ): Promise<void> => {
    if (!editorDocument.save.isDirty()) return Promise.resolve()
    const snapshot = editorDocument.save.snapshot()
    if (!snapshot.revision) return Promise.resolve()
    const captured = editor ? captureEditorRecoveryViewState(editor) : undefined
    return recovery.checkpoint({
      workspacePath: worktreePath,
      relPath,
      content: snapshot.content,
      originalRevision: snapshot.revision,
      bufferVersion: snapshot.bufferVersion,
      ...(captured === undefined ? {} : { viewState: captured })
    })
  }

  const scheduleRecoveryCheckpoint = (editorDocument: EditorDocument): void => {
    window.clearTimeout(recoveryTimerRef.current)
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = undefined
      void persistRecoveryCheckpoint(editorDocument, editorRef.current).catch(() => undefined)
    }, RECOVERY_CHECKPOINT_DELAY_MS)
  }

  useEffect(() => {
    const synchronize = (): void => {
      const status = recovery.statusFor({ workspacePath: worktreePath, relPath })
      const loadError = recovery.getSnapshot().error
      setRecoveryStatus(status.phase === 'idle' && loadError ? { phase: 'error', error: loadError } : status)
    }
    synchronize()
    return recovery.subscribe(synchronize)
  }, [recovery, relPath, worktreePath])

  // Store acknowledgements are intentionally absent from this dependency list;
  // the source epoch observer below decides whether external text can be adopted.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !preview || mode === 'preview') return
    let cancelled = false
    let disposeEditor: (() => void) | undefined

    const mountEditor = async (): Promise<void> => {
      setEditorMountError(null)
      let editorDocument = getEditorDocument(worktreePath, relPath)
      let recovered = editorDocument ? undefined : await recovery.draftFor({ workspacePath: worktreePath, relPath })
      if (cancelled) return
      const diskPreview = useAppStore.getState().previews[worktreePath]?.[relPath] ?? preview
      let latestRecoveryViewState = recovered?.viewState
      let recoveryEditor: monaco.editor.IStandaloneCodeEditor | null = null

      if (!editorDocument) {
        registerLanguageWorkspace(worktreePath)
        const separator = worktreePath.endsWith('/') || worktreePath.endsWith('\\') ? '' : '/'
        const uri = monaco.Uri.file(worktreePath + separator + diskPreview.path)
        const model = monaco.editor.createModel(recovered?.content ?? diskPreview.content, undefined, uri)
        const save = new VersionedEditorSave({
          initial: diskPreview,
          sourceEpoch: diskPreview.v,
          initialBufferVersion: Math.max(
            model.getVersionId(),
            recovery.bufferVersionFloorFor({ workspacePath: worktreePath, relPath })
          ),
          ...(recovered === undefined ? {} : { recovery: recovered }),
          write: (content, expectedRevision) => window.donwells.writeFile(worktreePath, relPath, content, expectedRevision),
          onSaveAck: ({ saved, sourceEpoch, savedVersion, currentBufferVersion }) => {
            useAppStore.getState().ackPreviewSave(worktreePath, relPath, saved, sourceEpoch)
            window.clearTimeout(recoveryTimerRef.current)
            recoveryTimerRef.current = undefined
            if (savedVersion === currentBufferVersion) {
              void recovery.acknowledgeSaved({ workspacePath: worktreePath, relPath }, savedVersion).catch(() => undefined)
              return
            }
            if (!saved.revision) return
            latestRecoveryViewState = recoveryEditor
              ? captureEditorRecoveryViewState(recoveryEditor) ?? latestRecoveryViewState
              : latestRecoveryViewState
            void recovery.checkpoint({
              workspacePath: worktreePath,
              relPath,
              content: model.getValue(),
              originalRevision: saved.revision,
              bufferVersion: currentBufferVersion,
              ...(latestRecoveryViewState === undefined ? {} : { viewState: latestRecoveryViewState })
            }).catch(() => undefined)
          }
        })
        editorDocument = {
          model,
          save,
          recovery: {
            waitForPersistence: () => recovery.waitForDocument({ workspacePath: worktreePath, relPath }),
            protects: snapshot => recovery.protects({ workspacePath: worktreePath, relPath }, snapshot)
          }
        }
        cacheEditorDocument(worktreePath, relPath, editorDocument)
      } else {
        editorDocument.recovery ??= {
          waitForPersistence: () => recovery.waitForDocument({ workspacePath: worktreePath, relPath }),
            protects: snapshot => recovery.protects({ workspacePath: worktreePath, relPath }, snapshot)
        }
        const update = editorDocument.save.observeExternal(diskPreview, diskPreview.v)
        if (update === 'adopted' && editorDocument.model.getValue() !== diskPreview.content) {
          applyingModelChange.current = true
          try {
            editorDocument.model.setValue(diskPreview.content)
          } finally {
            applyingModelChange.current = false
          }
        }
      }

      const releaseDocument = retainEditorDocument(worktreePath, relPath)
      const editor = monaco.editor.create(host, {
        model: editorDocument.model,
        fontSize: effectiveEditorFontSize(settings),
        fontFamily: effectiveEditorFontFamily(settings),
        automaticLayout: true,
        minimap: { enabled: settings.editorMinimap },
        wordWrap: settings.editorWordWrap,
        stickyScroll: { enabled: settings.editorStickyScroll },
        guides: { indentation: true, bracketPairs: true, highlightActiveIndentation: true },
        bracketPairColorization: { enabled: true },
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        renderWhitespace: settings.editorRenderWhitespace,
        quickSuggestions: { other: true, comments: false, strings: true },
        links: true,
        readOnly: !editorDocument.save.isWritable(),
        scrollBeyondLastLine: false,
        padding: { top: 8 },
        renderLineHighlight: 'line',
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        fixedOverflowWidgets: true
      })
      editorRef.current = editor
      const projectLanguage = attachProjectLanguageTools(monaco, editorDocument.model, worktreePath, relPath, message => useAppStore.getState().setError(message))
      const restartLanguages = editor.addAction({
        id: 'donwells.restartLanguageTools',
        label: 'Restart TypeScript / JavaScript tools',
        contextMenuGroupId: 'navigation',
        run: async () => { restartLanguageTools();try{await projectLanguage.restart()}catch(error){useAppStore.getState().setError(`Project language tools unavailable: ${String(error)}. Open-file TypeScript tools remain active.`)} }
      })
      const projectDefinition = editor.addAction({
        id: 'donwells.projectDefinition',
        label: 'Go to project definition',
        contextMenuGroupId: 'navigation',
        run: async () => {
          const position=editor.getPosition();if(!position)return
          try{const target=await projectLanguage.definition(position.lineNumber,position.column);if(target)await openPreview(worktreePath,target.path,{mode:'edit',line:target.start.line,column:target.start.column})}
          catch(error){useAppStore.getState().setError(`Project definition failed: ${String(error)}`)}
        }
      })
      let referenceIndex=0
      const projectReferences = editor.addAction({
        id: 'donwells.projectReferences',
        label: 'Go to next project reference',
        contextMenuGroupId: 'navigation',
        run: async () => {
          const position=editor.getPosition();if(!position)return
          try{const targets=await projectLanguage.references(position.lineNumber,position.column);if(!targets.length){useAppStore.getState().setError('No project references found.');return}const target=targets[referenceIndex++%targets.length]!;await openPreview(worktreePath,target.path,{mode:'edit',line:target.start.line,column:target.start.column})}
          catch(error){useAppStore.getState().setError(`Project references failed: ${String(error)}`)}
        }
      })
      const inspectSymbol = editor.addAction({
        id: 'donwells.inspectSymbolCallers',
        label: 'Find selected symbol callers',
        contextMenuGroupId: 'navigation',
        run: () => {
          try {
            const selection = editor.getSelection()
            const position = editor.getPosition()
            const symbol = selectedGraphSymbol(selection ? editor.getModel()?.getValueInRange(selection) ?? '' : '', position ? editor.getModel()?.getWordAtPosition(position)?.word ?? '' : '')
            useAppStore.setState(state => ({ contentSearch: { ...state.contentSearch, graphQuery: symbol, graphOpen: true } }))
            useAppStore.getState().setRightSidebarTab('search')
          } catch (error) { useAppStore.getState().setError(String(error)) }
        }
      })
      const languageNavigation = monaco.editor.registerEditorOpener({
        openCodeEditor: async (source, resource, position) => {
          if (source !== editor) return false
          const root = monaco.Uri.file(worktreePath)
          const prefix = root.path.replace(/\/$/, '') + '/'
          if (resource.scheme !== 'file' || resource.authority !== root.authority || !resource.path.startsWith(prefix)) {
            useAppStore.getState().setError('Language navigation target is outside this checkout.')
            return true
          }
          const line = position && ('startLineNumber' in position ? position.startLineNumber : position.lineNumber)
          const column = position && ('startColumn' in position ? position.startColumn : position.column)
          await openPreview(worktreePath, resource.path.slice(prefix.length), { mode: 'edit', line, column })
          return true
        }
      })
      recoveryEditor = editor
      documentRef.current = editorDocument
      editorDocument.model.updateOptions({ tabSize: settings.editorTabSize })
      const previousViewState = getDocumentViewState(worktreePath, relPath, 'edit')
      if (previousViewState) editor.restoreViewState(previousViewState)
      else if (recovered?.viewState) restoreEditorRecoveryViewState(editor, recovered.viewState)
      latestRecoveryViewState = captureEditorRecoveryViewState(editor) ?? latestRecoveryViewState

      const currentState = useAppStore.getState()
      const initialNavigation = currentState.documentNavigation[worktreePath]?.[relPath]
      if (initialNavigation && initialNavigation.mode !== 'preview' && initialNavigation.line !== undefined) {
        const lineNumber = Math.min(Math.max(1, initialNavigation.line), editorDocument.model.getLineCount())
        const column = Math.min(Math.max(1, initialNavigation.column ?? 1), editorDocument.model.getLineMaxColumn(lineNumber))
        const position = { lineNumber, column }
        editor.setPosition(position)
        editor.revealPositionInCenterIfOutsideViewport(position)
        if (currentState.activeWorktreePath === worktreePath && currentState.activePane[worktreePath] === 'preview:' + relPath) editor.focus()
      }

      const stopStatus = editorDocument.save.subscribe((state) => {
        setSaveState(state)
        editor.updateOptions({ readOnly: !editorDocument.save.isWritable() })
      })
      const changes = editor.onDidChangeModelContent(() => {
        if (applyingModelChange.current) return
        if (!editorDocument.save.edit(editorDocument.model.getValue(), editorDocument.model.getVersionId())) return
        scheduleRecoveryCheckpoint(editorDocument)
        scheduleAutoSave()
      })
      const captureViewSoon = (): void => {
        latestRecoveryViewState = captureEditorRecoveryViewState(editor) ?? latestRecoveryViewState
        if (editorDocument.save.isDirty()) scheduleRecoveryCheckpoint(editorDocument)
      }
      const cursorChanges = editor.onDidChangeCursorSelection(captureViewSoon)
      const scrollChanges = editor.onDidScrollChange(captureViewSoon)
      const persistBeforeSuspend = (): void => {
        if (!editorDocument.save.isDirty()) return
        latestRecoveryViewState = captureEditorRecoveryViewState(editor) ?? latestRecoveryViewState
        void persistRecoveryCheckpoint(editorDocument, editor).catch(() => undefined)
      }
      const persistWhenHidden = (): void => {
        if (window.document.visibilityState === 'hidden') persistBeforeSuspend()
      }
      window.addEventListener('blur', persistBeforeSuspend)
      window.document.addEventListener('visibilitychange', persistWhenHidden)

      const saveAction = editor.addAction({
        id: 'donwells.saveFile',
        label: 'Save file',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        contextMenuGroupId: '1_modification',
        run: async () => {
          window.clearTimeout(saveTimerRef.current)
          saveTimerRef.current = undefined
          await editorDocument.save.flush()
        }
      })

      disposeEditor = () => {
        projectLanguage.dispose()
        projectDefinition.dispose()
        projectReferences.dispose()
        languageNavigation.dispose()
        restartLanguages.dispose()
        inspectSymbol.dispose()
        saveAction.dispose()
        changes.dispose()
        cursorChanges.dispose()
        scrollChanges.dispose()
        stopStatus()
        window.removeEventListener('blur', persistBeforeSuspend)
        window.document.removeEventListener('visibilitychange', persistWhenHidden)
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = undefined
        window.clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = undefined
        const viewState = editor.saveViewState()
        if (viewState) saveDocumentViewState(worktreePath, relPath, 'edit', viewState)
        latestRecoveryViewState = captureEditorRecoveryViewState(editor) ?? latestRecoveryViewState
        if (editorDocument.save.isDirty()) void persistRecoveryCheckpoint(editorDocument, editor).catch(() => undefined)
        recoveryEditor = null
        if (autoSaveRef.current.mode === 'after-delay' && editorDocument.save.isDirty()) void editorDocument.save.flush()
        editor.dispose()
        releaseDocument()
        if (editorRef.current === editor) editorRef.current = null
        if (documentRef.current === editorDocument) documentRef.current = null
      }
    }

    void mountEditor().catch((error: unknown) => {
      if (cancelled) return
      const message = 'Editor recovery failed to initialize: ' + String(error)
      setEditorMountError(message)
      useAppStore.getState().setError(message)
    })
    return () => {
      cancelled = true
      disposeEditor?.()
    }
    // Settings update through updateOptions below; source epochs are observed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath, relPath, mode, mountAttempt])

  // Agent/store writes are external epochs. Same-epoch acknowledgements are
  // ignored, and a newer epoch never replaces a dirty model.
  useEffect(() => {
    if (!preview) return
    const document = getEditorDocument(worktreePath, relPath)
    if (!document) return
    const update = document.save.observeExternal(preview, preview.v)
    if (update !== 'adopted' || document.model.getValue() === preview.content) return
    applyingModelChange.current = true
    try {
      document.model.setValue(preview.content)
    } finally {
      applyingModelChange.current = false
    }
  }, [worktreePath, relPath, preview])

  // Settings live-apply without rebuilding the editor or its undo stack.
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: effectiveEditorFontSize(settings),
      fontFamily: effectiveEditorFontFamily(settings),
      wordWrap: settings.editorWordWrap,
      minimap: { enabled: settings.editorMinimap },
      stickyScroll: { enabled: settings.editorStickyScroll },
      renderWhitespace: settings.editorRenderWhitespace
    })
    documentRef.current?.model.updateOptions({ tabSize: settings.editorTabSize })
  }, [settings])

  // Changing the save policy applies to an already-dirty cached document too.
  useEffect(() => {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = undefined
    const document = getEditorDocument(worktreePath, relPath)
    if (settings.editorAutoSaveMode === 'after-delay' && document?.save.isDirty()) scheduleAutoSave()
    return () => {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
    }
    // scheduleAutoSave reads live refs and must not restart this effect per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, relPath, settings.editorAutoSaveDelayMs, settings.editorAutoSaveMode, worktreePath])

  useEffect(() => {
    if (!navigation || navigation.mode === 'preview' || mode === 'preview' || navigation.line === undefined) return
    const editor = editorRef.current
    const document = documentRef.current
    if (!editor || !document) return
    const lineNumber = Math.min(Math.max(1, navigation.line), document.model.getLineCount())
    const column = Math.min(
      Math.max(1, navigation.column ?? 1),
      document.model.getLineMaxColumn(lineNumber)
    )
    const position = { lineNumber, column }
    editor.setPosition(position)
    editor.revealPositionInCenterIfOutsideViewport(position)
    // Existing editors can still be hidden during this effect; focus after the dock reveals them.
    const frame = requestAnimationFrame(() => {
      const state = useAppStore.getState()
      if (state.activeWorktreePath === worktreePath && state.activePane[worktreePath] === 'preview:' + relPath) editor.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [mode, navigation, relPath, worktreePath])

  const retryOpenPreview = async (): Promise<void> => {
    if (previewRetrying) return
    setPreviewRetrying(true)
    setPreviewOpenError(null)
    await openPreview(worktreePath, relPath)
    if (!useAppStore.getState().previews[worktreePath]?.[relPath]) {
      setPreviewOpenError(useAppStore.getState().error ?? 'The file could not be opened.')
    }
    setPreviewRetrying(false)
  }

  if (!preview) {
    return (
      <div className="editor-pane">
        <div className="diff-error" role={previewOpenError ? 'alert' : 'status'}>
          <strong>File content unavailable</strong>
          <span>{previewOpenError ?? 'This editor pane no longer has loaded file content.'}</span>
          <button type="button" className="btn btn-secondary" disabled={previewRetrying} onClick={() => void retryOpenPreview()}>{previewRetrying ? 'Opening…' : 'Retry opening file'}</button>
        </div>
      </div>
    )
  }
  if (editorMountError) {
    return (
      <div className="editor-pane">
        <div className="diff-error" role="alert">
          <strong>Editor failed to start</strong>
          <span>{editorMountError}</span>
          <button type="button" className="btn btn-secondary" onClick={() => {
            setEditorMountError(null)
            setMountAttempt((attempt) => attempt + 1)
          }}>Retry editor</button>
        </div>
      </div>
    )
  }
  const rendered = mode === 'preview'
  const phase = saveState?.phase
  const hasUnsaved = saveState !== null && saveState.bufferVersion !== saveState.savedVersion
  const recoveryFailed = recoveryStatus.phase === 'error'
  const recoveryPending = recoveryStatus.phase === 'pending'
  const statusText = recoveryFailed
    ? 'Recovery failed'
    : phase === 'dirty'
      ? recoveryStatus.phase === 'protected' ? 'Unsaved · Recoverable' : recoveryPending ? 'Protecting changes…' : 'Unsaved'
      : phase === 'saving'
        ? 'Saving…'
        : phase === 'saved' && recoveryPending
          ? 'Finalizing recovery…'
          : phase === 'saved' && saveState?.savedAt !== undefined
            ? 'Saved ' + new Date(saveState.savedAt).toLocaleTimeString('en-GB', { hour12: false })
            : phase === 'failed'
              ? 'Save failed'
              : phase === 'conflict'
                ? 'Save conflict'
                : phase === 'readonly'
                  ? saveState?.readOnlyReason === 'truncated'
                    ? 'Read-only · truncated file prefix'
                    : 'Read-only · safe save unavailable'
                  : ''

  const retrySave = (): void => {
    const editorDocument = getEditorDocument(worktreePath, relPath)
    if (editorDocument) void editorDocument.save.flush()
  }

  const retryRecovery = (): void => {
    void recovery.retry({ workspacePath: worktreePath, relPath }).catch(() => undefined)
  }

  const reloadFromDisk = async (): Promise<void> => {
    if (reloading) return
    const editorDocument = getEditorDocument(worktreePath, relPath)
    if (!editorDocument) {
      setReloadError('The editor document is no longer available. Close this dialog and reopen the file.')
      return
    }
    setReloading(true)
    setReloadError(null)
    window.clearTimeout(recoveryTimerRef.current)
    recoveryTimerRef.current = undefined
    const discardedVersion = editorDocument.save.snapshot().bufferVersion
    const sourceEpoch = useAppStore.getState().previews[worktreePath]?.[relPath]?.v ?? editorDocument.save.snapshot().sourceEpoch
    try {
      const file = await window.donwells.readFile(worktreePath, relPath)
      const currentEpoch = useAppStore.getState().previews[worktreePath]?.[relPath]?.v
      if (currentEpoch !== undefined && currentEpoch !== sourceEpoch) {
        const message = 'File changed again while reload was in progress.'
        editorDocument.save.reportReloadFailure(message)
        setReloadError(message)
        return
      }
      if (editorDocument.save.snapshot().bufferVersion !== discardedVersion) {
        const message = 'The editor changed while reload was in progress; newer text was preserved.'
        editorDocument.save.reportReloadFailure(message)
        setReloadError(message)
        return
      }
      if (!editorDocument.save.reload(file, sourceEpoch)) {
        setReloadError(editorDocument.save.snapshot().error ?? 'The current file could not be adopted safely.')
        return
      }
      applyingModelChange.current = true
      try {
        if (editorDocument.model.getValue() !== file.content) editorDocument.model.setValue(file.content)
      } finally {
        applyingModelChange.current = false
      }
      useAppStore.getState().ackPreviewSave(worktreePath, relPath, file, sourceEpoch)
      await recovery.discardDocument({ workspacePath: worktreePath, relPath }, discardedVersion)
      setReloadConfirmationOpen(false)
    } catch (error: unknown) {
      editorDocument.save.reportReloadFailure(error)
      setReloadError(String(error))
    } finally {
      setReloading(false)
    }
  }

  return (
    <div className="editor-pane">
      {rendered ? (
        <MarkdownPreview worktreePath={worktreePath} relPath={relPath} />
      ) : (
        <div className="editor-host" ref={hostRef} />
      )}
      {!rendered && statusText && (
        <div
          className={`editor-status-chip${recoveryFailed || phase === 'failed' || phase === 'conflict' || (phase === 'readonly' && hasUnsaved) ? ' failed' : ''}`}
          title={recoveryStatus.error ?? saveState?.error}
        >
          <span role="status" aria-live="polite">{statusText}</span>
          {phase === 'failed' && (
            <button type="button" className="editor-status-action" onClick={retrySave}>Retry save</button>
          )}
          {recoveryFailed && (
            <button type="button" className="editor-status-action" onClick={retryRecovery}>Retry recovery</button>
          )}
          {(phase === 'failed' || phase === 'conflict' || (phase === 'readonly' && hasUnsaved)) && (
            <><button type="button" className="editor-status-action" onClick={() => {
              const current = documentRef.current
              if (!current) return
              const buffer = current.model.getValue()
              void persistRecoveryCheckpoint(current, editorRef.current).then(() => window.donwells.readFile(worktreePath, relPath)).then(file => {
                if (file.binary || file.truncated) throw new Error(file.binary ? 'Disk file is no longer text; your draft is retained' : 'Disk file is too large for a complete comparison')
                setComparison({ disk: file.content, buffer })
              }).catch(error => setCopyStatus(`Comparison failed; your draft is retained. ${String(error)}`))
            }}>Compare with disk</button><button type="button" className="editor-status-action" onClick={() => {
              const buffer = documentRef.current?.model.getValue()
              if (buffer === undefined) { setCopyStatus('Editor buffer unavailable'); return }
              void navigator.clipboard.writeText(buffer).then(() => setCopyStatus('Unsaved text copied'), error => setCopyStatus(`Copy failed: ${String(error)}`))
            }}>Copy unsaved text</button><button type="button" className="editor-status-action" onClick={() => setReloadConfirmationOpen(true)}>Reload</button><span role="status">{copyStatus}</span></>
          )}
        </div>
      )}
      {comparison && <ModalDialog labelledBy="editor-compare-title" className="modal editor-comparison-modal" onClose={() => setComparison(null)}>
        <h3 id="editor-compare-title" className="modal-title">Disk snapshot ↔ unsaved text</h3>
        <div ref={comparisonHost} style={{ width: '100%', height: '65dvh', flexShrink: 0 }} />
        <div className="modal-footer"><button className="btn btn-secondary btn-sm" onClick={() => setComparison(null)}>Close comparison</button></div>
      </ModalDialog>}
      {reloadConfirmationOpen && (
        <ModalDialog className="modal delete-modal" labelledBy="editor-reload-title" onClose={() => !reloading && setReloadConfirmationOpen(false)}>
          <h3 id="editor-reload-title" className="modal-title">Discard unsaved changes?</h3>
          <p>Reloading <strong>{relPath}</strong> replaces the editor buffer with the current file from disk.</p>
          {reloadError && <div role="alert">{reloadError}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={reloading} onClick={() => setReloadConfirmationOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-danger" disabled={reloading} onClick={() => void reloadFromDisk()}>{reloading ? 'Reloading…' : 'Discard and reload'}</button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
