import { isObject } from './command-catalog'
import type { ToolServiceState } from './project-tools'

export const PROJECT_TOOL_FIELDS = {
  codeGraphBinary: 'Code graph executable',
  qmdPackage: 'QMD package directory',
  lancePackage: 'LanceDB package directory',
  embeddingModel: 'Embedding model file',
  rerankingModel: 'Reranking model file',
  browserPackage: 'Playwright MCP package directory',
  browserExecutable: 'Browser executable',
  computerBinary: 'Cua Driver executable'
} as const
export type ProjectToolConfiguration = Partial<Record<keyof typeof PROJECT_TOOL_FIELDS, string>> & { referenceRoots: string[]; disabled: string[] }
export const INTEGRATED_PROJECT_TOOLS = [
  { id: 'code-graph', name: 'Code graph', version: '0.10.8', source: 'https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.10.8', scope: 'Checkout source; private derived graph', models: 'None', fields: ['codeGraphBinary'] },
  { id: 'documents', name: 'Document retrieval', version: 'QMD 2.8.3 / LanceDB 0.38.0', source: 'https://github.com/tobi/qmd', scope: 'Checkout and explicitly selected reference folders', models: 'Lexical search needs no model. Hybrid search requires the admitted embedding and reranking files.', fields: ['qmdPackage', 'lancePackage', 'embeddingModel', 'rerankingModel'] },
  { id: 'browser-testing', name: 'Browser testing', version: 'MCP 0.0.80 / core 1.63.0-alpha-2026-08-31', source: 'https://github.com/microsoft/playwright-mcp', scope: 'Separate managed browser bound to the local preview; not a network sandbox', models: 'None', fields: ['browserPackage', 'browserExecutable'] },
  { id: 'computer-control', name: 'Computer control', version: 'Cua Driver 0.23.2', source: 'https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.23.2', scope: 'Explicitly attached native window; foreground actions share a desktop lease', models: 'None', fields: ['computerBinary'] }
] as const

export function parseProjectToolConfiguration(value: unknown): ProjectToolConfiguration {
  if (!isObject(value) || Object.keys(value).some(key => !Object.hasOwn(PROJECT_TOOL_FIELDS, key) && key !== 'referenceRoots' && key !== 'disabled')) throw new Error('Invalid project tool configuration fields')
  const result: ProjectToolConfiguration = { referenceRoots: [], disabled: [] }
  for (const key of Object.keys(PROJECT_TOOL_FIELDS) as Array<keyof typeof PROJECT_TOOL_FIELDS>) {
    if (value[key] === undefined || value[key] === '') continue
    if (typeof value[key] !== 'string' || value[key].length > 4096 || /[\x00-\x1f\x7f]/.test(value[key]) || !value[key].startsWith('/')) throw new Error('Tool paths must be bounded absolute local paths')
    result[key] = value[key]
  }
  const roots = value.referenceRoots ?? [], disabled = value.disabled ?? []
  if (!Array.isArray(roots) || roots.length > 15 || roots.some(path => typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) throw new Error('Select at most 15 absolute reference folders')
  if (!Array.isArray(disabled) || disabled.length > INTEGRATED_PROJECT_TOOLS.length || disabled.some(id => !INTEGRATED_PROJECT_TOOLS.some(tool => tool.id === id))) throw new Error('Unknown disabled tool')
  result.referenceRoots = [...new Set(roots)]
  result.disabled = [...new Set(disabled)]
  return result
}

export type ProjectDoctorReport = {
  workspacePath: string
  configuration: ProjectToolConfiguration
  revision: string | null
  configurationPath: string
  problem: string | null
  services: ToolServiceState[]
  resources: Array<{ field: keyof typeof PROJECT_TOOL_FIELDS; bytes: number | null; problem: string | null }>
  availableDiskBytes: number | null
}
