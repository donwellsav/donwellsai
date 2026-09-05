import { useCallback, useEffect, useRef, useState } from 'react'
import {
  validateBinaryPreviewPayload,
  type BinaryPreviewPayload,
  type MediaPreviewKind
} from '@shared/media-preview'

export type BinaryPreviewLoadState =
  | Readonly<{ status: 'loading'; generation: number }>
  | Readonly<{ status: 'ready'; generation: number; payload: BinaryPreviewPayload }>
  | Readonly<{ status: 'error'; generation: number; message: string }>

let generationSequence = 0

function nextGeneration(): number {
  generationSequence = generationSequence >= Number.MAX_SAFE_INTEGER ? 1 : generationSequence + 1
  return generationSequence
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const remotePrefix = /^Error invoking remote method '[^']+': Error: /
  return error.message.replace(remotePrefix, '')
}

/**
 * Correlates every IPC load with a generation and ignores all completions after
 * retry, path change, or unmount. The main reader independently verifies that
 * the file was stable for the entire read.
 */
export function useBinaryPreview(
  worktreePath: string,
  path: string,
  kind: MediaPreviewKind
): Readonly<{ state: BinaryPreviewLoadState; retry: () => void }> {
  const [retryRevision, setRetryRevision] = useState(0)
  const generationRef = useRef(0)
  const [state, setState] = useState<BinaryPreviewLoadState>(() => ({
    status: 'loading',
    generation: 0
  }))

  useEffect(() => {
    const generation = nextGeneration()
    generationRef.current = generation
    let cancelled = false
    setState({ status: 'loading', generation })
    const request = { path, kind, generation } as const

    void window.donwells.readBinaryPreview(worktreePath, request).then((value) => {
      const payload = validateBinaryPreviewPayload(value, request)
      if (!cancelled && generationRef.current === generation) {
        setState({ status: 'ready', generation, payload })
      }
    }).catch((error: unknown) => {
      if (!cancelled && generationRef.current === generation) {
        setState({ status: 'error', generation, message: errorMessage(error) })
      }
    })

    return () => {
      cancelled = true
      void window.donwells.cancelBinaryPreview(generation).catch(() => undefined)
      if (generationRef.current === generation) generationRef.current = 0
    }
  }, [kind, path, retryRevision, worktreePath])

  const retry = useCallback(() => {
    setRetryRevision((revision) => revision + 1)
  }, [])

  return { state, retry }
}
