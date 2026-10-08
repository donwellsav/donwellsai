/**
 * Fuzzy subsequence matching (VS Code/upstream-grade feel): needle chars must
 * appear in order; score favors word starts, consecutiveness, and earlier
 * positions. Returns match indices so the UI can highlight hits.
 */
export type FuzzyResult = { score: number; hits: number[] }

const WORD_BOUNDARY = /[\s\-_./:\\]/

export function fuzzyMatch(text: string, needle: string): FuzzyResult | null {
  const normalizedNeedle = needle.trim()
  if (!normalizedNeedle) return { score: 0, hits: [] }
  if (normalizedNeedle.length > 256 || text.length > 4_096) return null
  const t = text.toLocaleLowerCase()
  const n = normalizedNeedle.toLocaleLowerCase()
  const hits: number[] = []
  let score = 0
  let ti = 0
  for (let ni = 0; ni < n.length; ni += 1) {
    const ch = n[ni]
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    // bonuses
    score += 10
    if (found === 0 || WORD_BOUNDARY.test(t[found - 1] ?? ' ')) score += 12 // word start
    if (found === ti) score += 8 // consecutive with previous hit
    if (found < 3) score += 4 // early in the string
    // gap penalty (distance since last hit)
    if (ni > 0) score -= Math.min(found - ti, 10)
    hits.push(found)
    ti = found + 1
  }
  // shorter candidates rank higher on equal hits
  score -= Math.floor(text.length / 8)
  return { score, hits }
}
