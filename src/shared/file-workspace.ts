import type { FileContent, FileEntry } from './types'

export const MAX_DIRECTORY_ENTRIES = 4_096
export const MAX_FILE_SEARCH_RESULTS = 100
export const MAX_FILE_SEARCH_CANDIDATES = 50_000
export const MAX_FILE_SEARCH_QUERY_LENGTH = 256
export const MAX_FILE_SEARCH_MRU = 64

export type WorkspaceDirectoryRequest = {
  directory: string
  showHidden: boolean
  includeIgnored: boolean
}

export type WorkspaceDirectoryResult = {
  directory: string
  entries: FileEntry[]
  /** More entries existed than could be returned safely. */
  truncated: boolean
}

export type WorkspaceFileSearchRequest = {
  query: string
  maxResults?: number
  mruPaths?: string[]
  showHidden: boolean
  includeIgnored: boolean
}

export type WorkspaceFileMatch = {
  entry: FileEntry
  score: number
  /** Character offsets in entry.path used by the renderer for highlighting. */
  hits: number[]
}

export type WorkspaceFileSearchResult = {
  matches: WorkspaceFileMatch[]
  scanned: number
  /** Candidate or result bounds prevented a complete result set. */
  truncated: boolean
}

export type WorkspaceCreateRequest = {
  path: string
  kind: 'file' | 'dir'
  content?: string
}

export type WorkspaceMoveRequest = {
  sourcePath: string
  destinationPath: string
}

export type WorkspaceDuplicateRequest = WorkspaceMoveRequest

export type WorkspaceDeleteRequest = {
  path: string
}

export type WorkspaceMutationResult = {
  path: string
  kind: 'file' | 'dir'
  previousPath?: string
}

/**
 * Workspace-document API shared by main, preload, and renderer. Implementations
 * must authorize workspacePath before delegating to the confined filesystem.
 */
export type FileWorkspaceApi = {
  listWorkspaceDirectory(workspacePath: string, request: WorkspaceDirectoryRequest): Promise<WorkspaceDirectoryResult>
  searchWorkspaceFiles(workspacePath: string, request: WorkspaceFileSearchRequest): Promise<WorkspaceFileSearchResult>
  readFile(workspacePath: string, relPath: string): Promise<FileContent>
  writeFile(workspacePath: string, relPath: string, content: string, expectedRevision?: string): Promise<FileContent>
  readPreviewImage(workspacePath: string, documentPath: string, source: string): Promise<string>
  createWorkspaceEntry(workspacePath: string, request: WorkspaceCreateRequest): Promise<WorkspaceMutationResult>
  moveWorkspaceEntry(workspacePath: string, request: WorkspaceMoveRequest): Promise<WorkspaceMutationResult>
  duplicateWorkspaceEntry(workspacePath: string, request: WorkspaceDuplicateRequest): Promise<WorkspaceMutationResult>
  deleteWorkspaceEntry(workspacePath: string, request: WorkspaceDeleteRequest): Promise<WorkspaceMutationResult>
}
