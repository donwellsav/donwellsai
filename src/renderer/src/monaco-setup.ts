/* Monaco core + only the features/languages the app ships (tree-shaken imports;
 * the full env lives at 'monaco-editor' and weighs ~8 MB). */
import * as monaco from 'monaco-editor/editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

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

import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
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

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
// Debug/agent handle: tooling (CDP probes, CLI eval) can read live models.
;(window as unknown as Record<string, unknown>).monaco = monaco

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
    'editor.background': '#0a0a0a',
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

export { monaco }
