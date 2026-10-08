#!/usr/bin/env node
/**
 * CSS orphan check.
 *
 * Dead CSS is this repo's largest silent-error surface: deleting the wrong rule
 * breaks styling with no compiler error and no failing test. 148 orphan rule
 * blocks were removed by hand precisely because nothing could check this.
 *
 * This script compares two sets:
 *
 *   defined = class selectors appearing in the repo's own stylesheets
 *   emitted = class names the TS/TSX applies via className / classList / query
 *             selectors, plus every class-shaped string literal anywhere in the
 *             sources as a low-confidence net
 *
 * and reports both directions:
 *
 *   ORPHANS    defined but never emitted  (deletion candidates)
 *   UNDEFINED  emitted but never defined  (typos / stale utilities)
 *
 * It is deliberately CONSERVATIVE. A class is never reported as a deletion
 * candidate when it is involved in:
 *
 *   - dynamic construction  (`` `is-${state}` `` registers the `is-` prefix,
 *     so every `is-*` class is protected; a template literal containing any
 *     interpolation also protects every literal chunk inside it)
 *   - a vendor family       (mermaid, pdf.js, katex, xterm, monaco,
 *     flexlayout__*) whose classes are emitted by third-party JavaScript and
 *     never appear in our className strings - yet repo stylesheets legitimately
 *     override them
 *   - ancestor-hook usage   (a class in a non-final compound, e.g. `.a` in
 *     `.a .b`, is a structural hook; removing its rule can change descendants)
 *   - a functional pseudo   (`.a:not(.b)` - the argument is not a plain subject)
 *   - any weak signal        (the class name occurs as a class-shaped string
 *     literal anywhere in the scanned sources)
 *
 * Default behaviour is WARN: print the report and exit 0. Pass --fail to exit 1
 * when deletion candidates exist.
 *
 * Usage:
 *   node scripts/check-css-orphans.mjs [--fail] [--json] [--max=N] [--quiet-protected]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Directories scanned for stylesheets and for class-emitting source. */
const CSS_ROOTS = ['src']
const USAGE_ROOTS = ['src', 'e2e']

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-cli', 'out', 'build', 'graphite', 'graphflow-out', '.graphflow', '.superpowers', 'test-results', 'playwright-report'])

/**
 * Class families emitted by third-party JavaScript. Our stylesheets may still
 * target them (workbench-dock.css overrides .flexlayout__*, main.css overrides
 * .katex and the pdf.js text layer), so they must never be called orphaned.
 */
const VENDOR_PREFIXES = [
  'mermaid', 'katex', 'xterm', 'monaco', 'flexlayout__',
  // pdf.js builds its viewer, text layer and highlight layer at runtime.
  'pdfViewer', 'pdfjs', 'pdf-', 'pdf_',
  'markedContent', 'textLayer', 'highlightLayer', 'annotationLayer', 'canvasWrapper',
  'cm-', 'cm_', 'CodeMirror', 'tok-',
  'kw-', 'pl-', 'dt-', 'nb-', 'nf-', 'nv-', 's-', 'sr-',
  'leaflet', 'mapboxgl', 'cm-editor', 'vp-', 'mammoth'
]

/** A class-shaped identifier: no dots, slashes, colons or whitespace. */
const CLASS_TOKEN = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/

/**
 * A dynamic class prefix: a leading class-shaped chunk ending in `-`/`_`, e.g.
 * the `is-` of `` `is-${state}` ``. Anything longer is prose inside a string
 * literal, not a prefix, and must not be registered.
 */
const CLASS_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*[-_]$/

const args = new Set(process.argv.slice(2))
const flagValue = (name, fallback) => {
  const hit = [...args].find(a => a.startsWith(`${name}=`))
  return hit === undefined ? fallback : Number(hit.slice(name.length + 1))
}
const OPTIONS = {
  fail: args.has('--fail'),
  json: args.has('--json'),
  quietProtected: args.has('--quiet-protected'),
  max: flagValue('--max', 40)
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

function walk(root, extensions, found = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      walk(full, extensions, found)
    } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
      found.push(full)
    }
  }
  return found
}

const rel = file => relative(REPO_ROOT, file).split(sep).join('/')

// ---------------------------------------------------------------------------
// CSS parsing
// ---------------------------------------------------------------------------

/** Removes comments while preserving newlines so line numbers stay truthful. */
const stripCssComments = css => css.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))

/**
 * Yields every rule prelude (the selector text before a `{`) with its 1-based
 * line. Precludes starting with `@` are at-rules (`@media`, `@keyframes`,
 * `@supports`) and are not selectors - but rules nested inside them are still
 * reached, because the scan is flat and depth-agnostic.
 */
function cssPreludes(css) {
  const preludes = []
  let buffer = ''
  let bufferLine = 1
  let line = 1
  let depth = 0
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    if (char === '\n') line += 1
    if (char === '{') {
      const prelude = buffer.trim()
      if (prelude && !prelude.startsWith('@')) {
        const leading = buffer.length - buffer.trimStart().length
        preludes.push({ selector: prelude, line: bufferLine + countNewlines(buffer.slice(0, leading)) })
      }
      buffer = ''
      depth += 1
    } else if (char === '}') {
      buffer = ''
      depth = Math.max(0, depth - 1)
    } else if (char === ';' && depth === 0) {
      buffer = ''
    } else {
      if (buffer === '') bufferLine = line
      buffer += char
    }
  }
  return preludes
}

const countNewlines = text => (text.match(/\n/g) ?? []).length

/** Splits one selector on top-level combinators, ignoring parentheses content. */
function compounds(selector) {
  const parts = []
  let current = ''
  let parens = 0
  for (const char of selector) {
    if (char === '(') parens += 1
    if (char === ')') parens = Math.max(0, parens - 1)
    const isCombinator = parens === 0 && (char === '>' || char === '+' || char === '~' || /\s/.test(char))
    if (isCombinator) {
      if (current.trim()) parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const CLASS_IN_COMPOUND = /\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g

/**
 * Class tokens of one compound, split into those outside and inside a
 * functional pseudo. Attribute selectors are removed first so a dot inside
 * `[data-x="a.b"]` cannot be mistaken for a class.
 */
function compoundClasses(compound) {
  const withoutAttributes = compound.replace(/\[[^\]]*\]/g, ' ')
  const outside = [...withoutAttributes.replace(/\([^)]*\)/g, ' ').matchAll(CLASS_IN_COMPOUND)].map(m => m[1])
  const inside = [...withoutAttributes.matchAll(/\(([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(CLASS_IN_COMPOUND)].map(x => x[1]))
  return { outside, inside }
}

/**
 * defined: class -> { subject, ancestor, chain, pseudo } lists of `file:line`.
 *
 * The role decides eligibility: only `subject` classes are ever reported as
 * deletion candidates. Every other sighting protects the class, because in each
 * case the element carrying it is assembled somewhere the static scan cannot
 * see well enough to justify a deletion.
 */
function collectDefined() {
  const defined = new Map()
  const record = (name, role, site) => {
    if (!defined.has(name)) defined.set(name, { subject: [], descendantSubject: [], ancestor: [], chain: [], pseudo: [] })
    defined.get(name)[role].push(site)
  }
  const files = CSS_ROOTS.flatMap(root => walk(join(REPO_ROOT, root), ['.css']))
  for (const file of files) {
    const css = stripCssComments(readFileSync(file, 'utf8'))
    for (const { selector, line } of cssPreludes(css)) {
      const site = `${rel(file)}:${line}`
      const parts = compounds(selector)
      const descendantRule = parts.length > 1
      parts.forEach((compound, index) => {
        const { outside, inside } = compoundClasses(compound)
        // A compound carrying several classes (`.git-status-letter.A`) describes
        // one element that must hold all of them, so its members are usually
        // assembled by concatenation. None of them is a safe deletion subject -
        // and reporting the single-letter half of such a pair is pure noise.
        //
        // The subject of a descendant rule (`.agent-chip .agent-cmd`) is kept
        // apart from a standalone subject (`.agent-cmd`): the first can only be
        // called dead once the ancestor's component is known not to emit it
        // dynamically, so it is evidence for review, not for deletion.
        const role = outside.length > 1 ? 'chain' : index < parts.length - 1 ? 'ancestor' : descendantRule ? 'descendantSubject' : 'subject'
        for (const name of outside) record(name, role, site)
        for (const name of inside) record(name, 'pseudo', site)
      })
    }
  }
  return defined
}

// ---------------------------------------------------------------------------
// TypeScript / HTML usage parsing
// ---------------------------------------------------------------------------

const isClassShaped = token => CLASS_TOKEN.test(token)

/** Adds every whitespace-separated class-shaped token of a class-list string. */
function addClassList(target, text) {
  for (const token of text.split(/\s+/)) if (token && isClassShaped(token)) target.add(token)
}

/**
 * A string that is nothing but class names - no selector metacharacters, no
 * attribute values, no slashes. Only such a string is evidence that a class was
 * put on an element, so only such a string feeds the `applied` set. Without
 * this, `[type="password"]` and `[aria-hidden="true"]` report `password` and
 * `true` as undefined classes, which is noise rather than a finding.
 */
const PURE_CLASS_LIST = /^[A-Za-z_][A-Za-z0-9_-]*(?:\s+[A-Za-z_][A-Za-z0-9_-]*)*$/

function addAppliedClassList(target, text) {
  const trimmed = text.trim()
  if (trimmed && PURE_CLASS_LIST.test(trimmed)) addClassList(target, trimmed)
}

/** Reads a quoted string starting at `index` (which must be the quote). */
function readQuoted(source, index) {
  const quote = source[index]
  let out = ''
  let cursor = index + 1
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '\\') { out += source[cursor + 1] ?? ''; cursor += 2; continue }
    if (char === quote) return { text: out, end: cursor + 1 }
    out += char
    cursor += 1
  }
  return { text: out, end: source.length }
}

/** Reads a balanced `{...}` / `(...)` / `` `...` `` region starting at `index`. */
function readBalanced(source, index) {
  const open = source[index]
  if (open === '`') {
    // Template literal: scan to the matching backtick, stepping over `$\{...}`.
    let cursor = index + 1
    while (cursor < source.length) {
      const char = source[cursor]
      if (char === '\\') { cursor += 2; continue }
      if (char === '`') return { text: source.slice(index, cursor + 1), end: cursor + 1 }
      if (char === '$' && source[cursor + 1] === '{') { cursor = readBalanced(source, cursor + 1).end; continue }
      cursor += 1
    }
    return { text: source.slice(index), end: source.length }
  }
  const close = open === '{' ? '}' : ')'
  let depth = 0
  let cursor = index
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '"' || char === "'") { cursor = readQuoted(source, cursor).end; continue }
    if (char === '`') { cursor = readBalanced(source, cursor).end; continue }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return { text: source.slice(index, cursor + 1), end: cursor + 1 }
    }
    cursor += 1
  }
  return { text: source.slice(index), end: source.length }
}

/**
 * Extracts every literal class signal from one expression region.
 *
 * A template literal with interpolation is treated as dynamic: the static
 * chunks that end in `-` or `_` become protected prefixes (`` `is-${x}` `` ->
 * `is-`), every literal chunk inside the template is protected, and quoted
 * strings nested in the interpolation are still read as emitted classes
 * (`` `base${on ? ' base-on' : ''}` `` emits both).
 *
 * Two sets come out of this. Every literal lands in `strong`, because that set
 * only ever *protects* a stylesheet class from being called orphaned. A literal
 * reaches `applied` - the set that can be reported as undefined - only when it
 * is genuinely put on an element, which excludes selector strings and excludes
 * operands of a comparison: in `kind === 'amend' ? 'is-amend' : ''` the first
 * string is a domain enum, the second is a class.
 */
function readExpression(source, region, out, appliedToElements = true) {
  let index = 0
  while (index < region.length) {
    const char = region[index]
    if (char === '"' || char === "'") {
      const { text, end } = readQuoted(region, index)
      const isComparisonOperand = /(?:===|!==|==|!=)$/.test(region.slice(0, index).trimEnd())
      addClassList(out.strong, text)
      if (appliedToElements && !isComparisonOperand) addAppliedClassList(out.applied, text)
      index = end
      continue
    }
    if (char === '`') {
      const { text, end } = readBalanced(region, index)
      const body = text.slice(1, -1)
      if (body.includes('${')) {
        out.dynamic = true
        let cursor = 0
        let chunk = ''
        const settleChunk = () => {
          if (!chunk.trim()) { chunk = ''; return }
          // A chunk ending in `-`/`_` is a prefix: `` `is-${x}` `` makes every
          // `is-*` class reachable, so the family is protected rather than the
          // chunk being read as a class name of its own.
          if (CLASS_PREFIX.test(chunk.trimEnd()) && chunk.trimEnd().length <= 64) {
            out.prefixes.add(chunk.trimEnd())
            addClassList(out.protectedTokens, chunk)
          } else {
            addClassList(out.strong, chunk)
            addClassList(out.protectedTokens, chunk)
            if (appliedToElements) addAppliedClassList(out.applied, chunk)
          }
          chunk = ''
        }
        while (cursor < body.length) {
          if (body.startsWith('${', cursor)) {
            settleChunk()
            const { text: inner, end: innerEnd } = readBalanced(body, cursor + 1)
            // Nested literals inside the interpolation are real emissions.
            readExpression(body, inner.slice(1, -1), out, appliedToElements)
            cursor = innerEnd
            continue
          }
          chunk += body[cursor]
          cursor += 1
        }
        settleChunk()
      } else {
        addClassList(out.strong, body)
        if (appliedToElements) addAppliedClassList(out.applied, body)
      }
      index = end
      continue
    }
    if (char === '{' || char === '(') {
      const { text, end } = readBalanced(region, index)
      readExpression(region, text.slice(1, -1), out, appliedToElements)
      index = end
      continue
    }
    index += 1
  }
  return out
}

/**
 * `strong` is every class the scan can see emitted; `applied` narrows that to
 * classes actually put on an element (className / classList / class=), which is
 * the only evidence strong enough to call a class undefined. Selector strings
 * are full of element names and attribute values that are not classes at all.
 */
const emptyUsage = () => ({ strong: new Set(), applied: new Set(), weak: new Set(), protectedTokens: new Set(), prefixes: new Set(), dynamic: false, sites: new Map() })

/** TypeScript/TSX: className, classList.*, and class-taking query selectors. */
function collectUsage() {
  const usage = emptyUsage()
  const files = USAGE_ROOTS.flatMap(root => walk(join(REPO_ROOT, root), ['.ts', '.tsx', '.html']))

  const CONTEXTS = [
    /className\s*=/g,
    /classList\s*\.\s*(?:add|remove|toggle|contains|replace)\s*\(/g,
    /(?:querySelector|querySelectorAll|closest|matches|getElementsByClassName)\s*\(/g,
    /\bclass\s*=/g
  ]
  // Selector strings such as '.runs-panel .row' - the leading dot is the class.
  // Kept WITHOUT /g so `.test()` below stays stateless.
  const SELECTOR_CALL = /(?:querySelector|querySelectorAll|closest|matches|getElementsByClassName)\s*\(/

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const name = rel(file)

    // --- strong signals: class-carrying call sites -------------------------
    for (const pattern of CONTEXTS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(source)) !== null) {
        const isSelector = SELECTOR_CALL.test(match[0])
        let cursor = match.index + match[0].length
        // className= / class= : skip to the value
        if (/=\s*$/.test(match[0])) {
          while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
        }
        if (cursor >= source.length) continue
        const char = source[cursor]
        let region
        if (char === '"' || char === "'") {
          // The overwhelmingly common form: className="a b". The quoted body is
          // already the class list, so it is read directly rather than being
          // handed back to the expression scanner, which only looks for quotes.
          region = readQuoted(source, cursor).text
          addClassList(usage.strong, region)
          if (!isSelector) addAppliedClassList(usage.applied, region)
        } else if (char === '`' || char === '{' || char === '(') {
          region = readBalanced(source, cursor).text.slice(1, -1)
          readExpression(source, region, usage, !isSelector)
        } else continue
        const before = new Set(usage.strong)
        readExpression(source, region, usage)
        if (isSelector) {
          // Only dotted names are classes here. A selector string legitimately
          // also carries element names, `[attr]` tokens and pseudo-classes, and
          // reporting those as undefined classes would be pure noise.
          for (const dotted of region.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) usage.strong.add(dotted[1])
        }
        for (const token of usage.strong) if (!before.has(token)) usage.sites.set(token, `${name}:${countNewlines(source.slice(0, match.index)) + 1}`)
      }
    }

    // --- weak net: any class-shaped string literal anywhere ----------------
    const LITERAL = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
    let literal
    while ((literal = LITERAL.exec(source)) !== null) {
      const body = literal[2]
      if (body.includes('${')) {
        for (const chunk of body.split(/\$\{[^}]*\}/)) {
          const candidate = chunk.trimEnd()
          if (CLASS_PREFIX.test(candidate) && candidate.length <= 64) usage.prefixes.add(candidate)
        }
      }
      for (const token of body.split(/[\s,;:[\](){}<>]+/)) if (token && isClassShaped(token) && token.length >= 2) usage.weak.add(token)
    }
  }

  // --- whole-repo dynamic construction -------------------------------------
  // Any template literal anywhere that builds a class-shaped prefix protects
  // that family, even when it sits outside a className call site.
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/([A-Za-z][A-Za-z0-9_-]*[-_])\$\{/g)) {
      if (CLASS_PREFIX.test(match[1]) && match[1].length <= 64) usage.prefixes.add(match[1])
    }
  }
  return usage
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const isVendor = name => VENDOR_PREFIXES.some(prefix => {
  if (prefix.endsWith('-') || prefix.endsWith('_')) return name.startsWith(prefix)
  return name === prefix || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}_`)
})

const matchesPrefix = (name, prefixes) => [...prefixes].some(prefix => prefix.length > 1 && name.startsWith(prefix))

function classify() {
  const defined = collectDefined()
  const usage = collectUsage()

  const orphans = []
  const descendantOnly = []
  const reviewOnly = []
  const protectedClasses = []

  for (const [name, roles] of [...defined].sort((a, b) => a[0].localeCompare(b[0]))) {
    const site = roles.subject[0] ?? roles.descendantSubject[0] ?? roles.chain[0] ?? roles.ancestor[0] ?? roles.pseudo[0]
    const emittedStrong = usage.strong.has(name)
    const emittedWeak = usage.weak.has(name)

    if (emittedStrong) continue

    const reasons = []
    if (emittedWeak) reasons.push('weak-string-literal')
    if (usage.protectedTokens.has(name)) reasons.push('inside-dynamic-template')
    if (matchesPrefix(name, usage.prefixes)) reasons.push('dynamic-prefix')
    if (isVendor(name)) reasons.push('vendor-family')
    if (roles.ancestor.length > 0) reasons.push('ancestor-hook')
    if (roles.chain.length > 0) reasons.push('multi-class-compound')
    if (roles.pseudo.length > 0) reasons.push('functional-pseudo')
    if (roles.subject.length === 0 && roles.descendantSubject.length === 0) reasons.push('never-a-subject')

    const entry = { name, site, subjectSites: roles.subject.length, reasons, weakSites: emittedWeak }
    if (reasons.length === 0 && roles.descendantSubject.length > 0) descendantOnly.push(entry)
    else if (reasons.length === 0) orphans.push(entry)
    else if (reasons.length === 1 && reasons[0] === 'weak-string-literal') reviewOnly.push(entry)
    else protectedClasses.push(entry)
  }

  // Classes emitted strongly but defined in no repo stylesheet.
  const undefinedClasses = []
  for (const name of [...usage.applied].sort()) {
    if (defined.has(name)) continue
    if (isVendor(name)) continue
    if (matchesPrefix(name, usage.prefixes)) continue
    undefinedClasses.push({ name, site: usage.sites.get(name) ?? 'unknown' })
  }

  return { defined, usage, orphans, descendantOnly, reviewOnly, protectedClasses, undefinedClasses }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function main() {
  const result = classify()
  const { defined, usage, orphans, descendantOnly, reviewOnly, protectedClasses, undefinedClasses } = result

  if (OPTIONS.json) {
    console.log(JSON.stringify({
      definedClasses: defined.size,
      emittedStrong: usage.strong.size,
      appliedOnElements: usage.applied.size,
      emittedWeak: usage.weak.size,
      dynamicPrefixes: [...usage.prefixes].sort(),
      orphans,
      descendantRuleOrphans: descendantOnly,
      reviewOnly,
      protected: protectedClasses,
      undefined: undefinedClasses
    }, null, 2))
    return OPTIONS.fail && orphans.length > 0 ? 1 : 0
  }

  const line = '─'.repeat(72)
  console.log(line)
  console.log('CSS orphan check')
  console.log(line)
  console.log(`stylesheets scanned : ${[...defined].length} distinct class selectors`)
  console.log(`emitted (strong)    : ${usage.strong.size} class names via className/classList/selectors`)
  console.log(`applied on elements : ${usage.applied.size} of those are real className/classList emissions`)
  console.log(`emitted (weak net)  : ${usage.weak.size} class-shaped string literals anywhere`)
  console.log(`dynamic prefixes    : ${[...usage.prefixes].filter(p => p.length > 1).sort().join(' ') || '(none)'}`)

  const list = (title, entries, note) => {
    console.log('')
    console.log(`${title} (${entries.length})`)
    if (note) console.log(`  ${note}`)
    if (entries.length === 0) { console.log('  none'); return }
    for (const entry of entries.slice(0, OPTIONS.max)) {
      const why = entry.reasons.length > 0 ? `  [protected: ${entry.reasons.join(', ')}]` : ''
      console.log(`  ${entry.name.padEnd(38)} ${entry.site}${why}`)
    }
    if (entries.length > OPTIONS.max) console.log(`  … ${entries.length - OPTIONS.max} more (raise --max)`)
  }

  list('ORPHANS — standalone rules defined but never emitted (deletion candidates)', orphans)
  list('REVIEW — subject of a descendant rule, never emitted (verify the ancestor)', descendantOnly,
    'an ancestor hook is involved, so these are never reported as deletable')
  list('REVIEW — only a weak string-literal signal, verify before touching', reviewOnly)
  if (!OPTIONS.quietProtected) {
    list('PROTECTED — never reported as deletable', protectedClasses,
      'dynamic construction, vendor families, ancestor hooks, functional pseudos')
  }
  console.log('')
  console.log(`UNDEFINED — applied to an element but styled by no repo stylesheet (${undefinedClasses.length})`)
  console.log('  Informational only. Some are deliberate JS-only hooks, and vendor/utility class')
  console.log('  strings (Tailwind leftovers) land here too — this is not a deletion list.')
  if (undefinedClasses.length === 0) console.log('  none')
  for (const entry of undefinedClasses.slice(0, OPTIONS.max)) console.log(`  ${entry.name.padEnd(38)} ${entry.site}`)
  if (undefinedClasses.length > OPTIONS.max) console.log(`  … ${undefinedClasses.length - OPTIONS.max} more (raise --max)`)

  console.log('')
  console.log(line)
  if (orphans.length === 0) {
    console.log('PASS — no orphan class selectors.')
  } else {
    console.log(`WARN — ${orphans.length} orphan class selector(s).`)
    console.log('These are deletion CANDIDATES, not a verdict: confirm each emits nothing')
    console.log('at runtime (dynamic class construction is the usual false positive).')
  }
  console.log('Mode: warn only (exit 0). Re-run with --fail to make orphans a hard failure.')
  console.log(line)

  return OPTIONS.fail && orphans.length > 0 ? 1 : 0
}

process.exit(main())
