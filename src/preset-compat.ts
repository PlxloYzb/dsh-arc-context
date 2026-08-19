/** Read-only preset compatibility audit helpers. */

export interface PresetCompatibility {
  /** True when the preset resolves compaction on the host plane (no isolate realm). */
  readonly inheritsHostCompaction: boolean
  /** True when the bridge can swap the composition's compaction backend in-realm. */
  readonly patchable: boolean
  readonly hasLocalBasic: boolean
  readonly hasLocalArc: boolean
  readonly isolatesCompaction: boolean
  readonly issues: readonly string[]
}

const BASIC_NAME = /(^|\n)\s*name:\s*['"]?@deepseek-ai\/dsh-compaction-basic['"]?\s*(?:\n|$)/
const ARC_NAME = /(^|\n)\s*name:\s*['"]?dsh-arc-context['"]?\s*(?:\n|$)/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** True only when `compaction: true` occurs inside an `isolate:` mapping. */
export function isolatesCompaction(text: string): boolean {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!/^\s*isolate:\s*$/.test(line)) continue
    const base = indentOf(line)
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!
      if (candidate.trim() === '' || candidate.trimStart().startsWith('#')) continue
      if (indentOf(candidate) <= base) break
      if (/^\s*compaction:\s*true\s*$/.test(candidate)) return true
    }
  }
  return false
}

/**
 * Audit one preset composition text against the bridge's takeover guards:
 * the bridge disables the official `compaction-basic` row by name and
 * inserts the engine row into the `compaction` isolate group, so a
 * composition is patchable exactly when it isolates a compaction realm and
 * mounts the official Basic row — or already selects ARC natively.
 */
export function inspectPresetComposition(text: string): PresetCompatibility {
  const hasLocalBasic = BASIC_NAME.test(text)
  const hasLocalArc = ARC_NAME.test(text)
  const isolated = isolatesCompaction(text)
  const issues = [
    ...(hasLocalBasic && hasLocalArc
      ? ['preset mounts both the official Basic row and a dsh-arc-context row; two backends cannot share one realm']
      : []),
    ...(isolated && !hasLocalBasic && !hasLocalArc
      ? ['preset isolates a compaction realm but mounts neither the official basic row nor dsh-arc-context; audit manually']
      : []),
  ]
  return {
    inheritsHostCompaction: !isolated,
    patchable: hasLocalArc || (isolated && hasLocalBasic),
    hasLocalBasic,
    hasLocalArc,
    isolatesCompaction: isolated,
    issues,
  }
}
