/* Monaco core + only the features/languages the app ships (tree-shaken imports;
 * the full env lives at 'monaco-editor' and weighs ~8 MB). */
import * as monaco from 'monaco-editor/editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import TypescriptWorker from './typescript-worker.js?worker'
import { typescriptDefaults, javascriptDefaults } from 'monaco-editor/languages/features/typescript/register.js'
import 'monaco-editor/editor/contrib/codelens/browser/codeLensCache.js'
import 'monaco-editor/editor/common/services/treeViewsDndService.js'
import { installLanguageDiagnostics } from './language-diagnostics'
import { useAppStore } from './store'

import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js'
import 'monaco-editor/editor/contrib/links/browser/links.js'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/highlightDecorations.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js'
// premium editing: sticky headers, F2 rename, peek defs/refs, quick fixes,
// format, inlay hints, F8 error nav, semantic tokens, snippets, confusable
// glyph warnings, linked tag editing — entry names per upstream editor.main
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js'
import 'monaco-editor/editor/contrib/rename/browser/rename.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js'
import 'monaco-editor/editor/contrib/format/browser/formatActions.js'
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js'
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js'
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js'
import 'monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js'
// hover tooltips (TS docs), F1 command palette + goto-symbol/goto-line,
// whole-document semantic colors
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'

import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
// TS language features (completion/hover/diagnostics for ts+js) — the ~4 MB
// worker is the difference between a text pane and an editor.
import 'monaco-editor/language/typescript/monaco.contribution.js'
// 0.56 ships no definition-only json; a small monarch grammar instead of the full JSON worker
monaco.languages.register({ id: 'json', extensions: ['.json', '.bowerrc', '.jscsrc', '.webmanifest'], aliases: ['JSON', 'json'], mimetypes: ['application/json'] })
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(\\.|[^"\\])*"(?=\s*:)/, 'key'],
      [/"(\\.|[^"\\])*"/, 'string'],
      [/\b(true|false|null)\b/, 'keyword'],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
      [/[{}[\]]/, '@brackets'],
      [/,/, 'delimiter'],
      [/:/, 'delimiter'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment']
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment']
    ]
  },
  brackets: [
    { open: '{', close: '}', token: 'delimiter.bracket' },
    { open: '[', close: ']', token: 'delimiter.bracket' }
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' }
  ]
})
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/rust/register.js'
import 'monaco-editor/languages/definitions/go/register.js'
import 'monaco-editor/languages/definitions/java/register.js'
import 'monaco-editor/languages/definitions/cpp/register.js'
import 'monaco-editor/languages/definitions/csharp/register.js'
import 'monaco-editor/languages/definitions/dockerfile/register.js'

const languageRoots = new Set<string>()
const languageWorkers = new Set<Worker>()
export function registerLanguageWorkspace(path: string): void {
  const uri = monaco.Uri.file(path).toString().replace(/\/$/, '') + '/'
  if (languageRoots.has(uri)) return
  languageRoots.add(uri)
  for (const worker of languageWorkers) worker.postMessage({ kind: 'donwells-language-roots', roots: [...languageRoots] })
}
export function restartLanguageTools(): void {
  typescriptDefaults.setWorkerOptions({ ...typescriptDefaults.workerOptions })
  javascriptDefaults.setWorkerOptions({ ...javascriptDefaults.workerOptions })
}
monaco.editor.onWillDisposeModel(() => queueMicrotask(() => {
  if (monaco.editor.getModels().some((model) => ['typescript', 'javascript'].includes(model.getLanguageId()))) return
  languageRoots.clear()
  restartLanguageTools()
}))
typescriptDefaults.setEagerModelSync(true)
javascriptDefaults.setEagerModelSync(true)
typescriptDefaults.setModeConfiguration({ ...typescriptDefaults.modeConfiguration, diagnostics: false })
javascriptDefaults.setModeConfiguration({ ...javascriptDefaults.modeConfiguration, diagnostics: false })
const reportLanguageError = (message: string): void => {
  queueMicrotask(() => useAppStore.getState().setError(message))
}
installLanguageDiagnostics(monaco, reportLanguageError)
self.MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) => {
    if (label !== 'typescript' && label !== 'javascript') return new EditorWorker()
    const worker = new TypescriptWorker()
    worker.addEventListener('error', () => reportLanguageError('Language worker stopped. Use “Restart TypeScript / JavaScript tools” in the editor command menu.'))
    languageWorkers.add(worker)
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => { languageWorkers.delete(worker); terminate() }
    worker.postMessage({ kind: 'donwells-language-roots', roots: [...languageRoots] })
    return worker
  }
}
// Debug/agent handle: tooling (CDP probes, CLI eval) can read live models.
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).monaco = monaco

monaco.editor.defineTheme('donwells-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '71717a', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c4b5fd' },
    { token: 'string', foreground: '86efac' },
    { token: 'number', foreground: 'fbbf24' },
    { token: 'type', foreground: '7dd3fc' }
  ],
  colors: {
    'editor.background': '#16161D',
    'editor.foreground': '#e4e4e7',
    'editorLineNumber.foreground': '#3f3f46',
    'editorLineNumber.activeForeground': '#a1a1aa',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorCursor.foreground': '#e4e4e7',
    'editor.selectionBackground': '#3f3f4680',
    'editor.inactiveSelectionBackground': '#3f3f4640',
    'editorWidget.background': '#18181b',
    'editorWidget.border': '#27272a',
    'editorIndentGuide.background1': '#1c1c1f',
    'editorIndentGuide.activeBackground1': '#27272a',
    'scrollbarSlider.background': '#3f3f4659',
    'scrollbarSlider.hoverBackground': '#52525b99',
    'scrollbarSlider.activeBackground': '#71717acc'
  }
})

monaco.editor.defineTheme('donwells-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#0a0a0a',
    'editorLineNumber.foreground': '#a3a3a3',
    'editorLineNumber.activeForeground': '#525252',
    'editor.lineHighlightBackground': '#f5f5f5',
    'editorCursor.foreground': '#171717',
    'editor.selectionBackground': '#d4d4d480',
    'editor.inactiveSelectionBackground': '#e5e5e580',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e5e5e5',
    'editorIndentGuide.background1': '#e5e5e5',
    'editorIndentGuide.activeBackground1': '#a3a3a3',
    'scrollbarSlider.background': '#a3a3a359',
    'scrollbarSlider.hoverBackground': '#73737380',
    'scrollbarSlider.activeBackground': '#52525299'
  }
})

export { monaco }
