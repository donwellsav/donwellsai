/** Pure markdown pre-pass helpers — no DOM, node-testable. */

/** Split YAML front matter (---…---) at document start. Values are plain strings. */
export function splitFrontMatter(md: string): { meta: Record<string, string> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
  if (!m) return { meta: null, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '')
  }
  return { meta: Object.keys(meta).length > 0 ? meta : null, body: md.slice(m[0].length) }
}

/** GitHub-style heading slug: lowercase, punctuation out, spaces → dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~\[\](){}<>.!?;:'",@#$%^&*=+\\|/]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** Decide which heavyweight renderers a doc needs (mermaid/katex stay lazy). */
export function scanNeeds(body: string): { mermaid: boolean; math: boolean } {
  const mermaid = /^```mermaid\b/m.test(body)
  // $$..$$ blocks, or $..$ inline that isn't an escape, currency, or empty
  const math = /\$\$[^$]+\$\$/s.test(body) || /(?<![\\$])\$[^\s$][^$]*\$(?!\d)/.test(body)
  return { mermaid, math }
}

/** GitHub alert variants: > [!NOTE] … */
export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'
export const CALLOUT_KINDS: ReadonlySet<string> = new Set(['note', 'tip', 'important', 'warning', 'caution'])

/** heading id for TOC entries, 3-char collision suffix handled by caller */
export type TocEntry = { id: string; depth: number; text: string }
