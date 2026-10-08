import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  canonicalResourceKey,
  type ArtifactRelationship,
  type TaskExecutionSpecificationInput,
  type VerificationArtifactInput
} from '@shared/task-authority'
import { OPERATIONAL_OUTPUT_LIMIT } from '@shared/operational-runs'

/** Evidence files larger than this are observed as present but never hashed into authority. */
export const TASK_EVIDENCE_MAX_FILE_BYTES = 32 * 1024 * 1024

export type TaskEvidenceFileObservation = Readonly<{
  /** Path exactly as required by the execution specification (relative to the workspace unless absolute). */
  path: string
  relationship: ArtifactRelationship
  existedBefore: boolean
  sha256Before: string | null
  bytesBefore: number | null
  /** Resolved absolute path used only for daemon-side reads. */
  absolutePath: string
}>

/**
 * Pre-run observation of one workspace. `workspaceRoot` is the realpath-based
 * canonical root; every artifact path is resolved strictly inside it.
 */
export type TaskEvidencePreObservation = Readonly<{
  workspaceRoot: string
  canonicalResourceKey: string
  capturedAt: string
  artifacts: readonly TaskEvidenceFileObservation[]
}>

export type TaskEvidencePostCapture = Readonly<{
  outputDigest: string
  outputBytes: number
  outputTruncated: boolean
  artifacts: readonly VerificationArtifactInput[]
}>

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

function observeFile(path: string, absolutePath: string, relationship: ArtifactRelationship, maxFileBytes: number): TaskEvidenceFileObservation {
  try {
    const metadata = statSync(absolutePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { path, relationship, existedBefore: true, sha256Before: null, bytesBefore: null, absolutePath }
    }
    if (metadata.size > maxFileBytes) {
      return { path, relationship, existedBefore: true, sha256Before: null, bytesBefore: metadata.size, absolutePath }
    }
    return { path, relationship, existedBefore: true, sha256Before: sha256Hex(readFileSync(absolutePath)), bytesBefore: metadata.size, absolutePath }
  } catch {
    return { path, relationship, existedBefore: false, sha256Before: null, bytesBefore: null, absolutePath }
  }
}

/**
 * Daemon-owned evidence port. It resolves the workspace through the
 * realpath-based canonical resolver, records pre-run state for every required
 * artifact, and after exit captures post-run artifact digests plus a bounded
 * output digest. It never calls Electron; arbitrary shell writes to the
 * workspace remain outside the reservation guarantee — only Donwells-mediated
 * capture through this port asserts the canonical workspace identity.
 */
export class DaemonTaskEvidencePort {
  observePre(specification: TaskExecutionSpecificationInput, workspaceRoot: string): TaskEvidencePreObservation {
    if (specification.target.kind !== 'local') {
      throw new Error('task evidence capture supports local execution targets only')
    }
    const resolvedRoot = realpathSync.native(workspaceRoot)
    const canonical = canonicalResourceKey(resolvedRoot)
    const artifacts = specification.verification.requiredArtifacts.map(required => {
      const absolute = isAbsolute(required.path) ? resolve(required.path) : resolve(join(resolvedRoot, required.path))
      if (!isInside(resolvedRoot, absolute)) {
        throw new Error(`required artifact path escapes the reserved workspace: ${required.path}`)
      }
      return observeFile(required.path, absolute, required.relationship, TASK_EVIDENCE_MAX_FILE_BYTES)
    })
    return { workspaceRoot: resolvedRoot, canonicalResourceKey: canonical, capturedAt: new Date().toISOString(), artifacts }
  }

  /**
   * Asserts the observed workspace still resolves to the reserved canonical
   * key before any post-run file read. This is the Donwells-mediated
   * file/artifact operation reservation assert.
   */
  assertReservedWorkspace(observation: TaskEvidencePreObservation, reservedCanonicalResourceKey: string): void {
    if (observation.canonicalResourceKey !== reservedCanonicalResourceKey) {
      throw new Error(`workspace ${observation.workspaceRoot} no longer matches the reserved canonical resource key`)
    }
  }

  capturePost(observation: TaskEvidencePreObservation, output: string, outputTruncated: boolean): TaskEvidencePostCapture {
    const truncatedOutput = output.length > OPERATIONAL_OUTPUT_LIMIT ? output.slice(output.length - OPERATIONAL_OUTPUT_LIMIT) : output
    const artifacts: VerificationArtifactInput[] = []
    for (const pre of observation.artifacts) {
      let captured: { sha256: string; bytes: number } | null = null
      try {
        const metadata = statSync(pre.absolutePath)
        if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= TASK_EVIDENCE_MAX_FILE_BYTES) {
          captured = { sha256: sha256Hex(readFileSync(pre.absolutePath)), bytes: metadata.size }
        }
      } catch {
        captured = null
      }
      if (captured === null) continue
      artifacts.push({
        path: pre.path,
        sha256: captured.sha256,
        bytes: captured.bytes,
        sourceFingerprint: pre.existedBefore ? pre.sha256Before : null,
        relationship: pre.relationship
      })
    }
    return {
      outputDigest: sha256Hex(Buffer.from(truncatedOutput, 'utf8')),
      outputBytes: Buffer.byteLength(truncatedOutput, 'utf8'),
      outputTruncated: outputTruncated || output.length > OPERATIONAL_OUTPUT_LIMIT,
      artifacts
    }
  }
}
