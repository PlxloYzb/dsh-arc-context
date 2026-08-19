#!/usr/bin/env node

/**
 * `dsh-arc-presets audit [preset-root]` — read-only audit of user preset
 * compositions against the bridge's takeover guards. The bridge never
 * writes preset files, so there is nothing to restore: uninstalling the
 * package (or restarting DSH without it) remounts the untouched original.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inspectPresetComposition } from './preset-compat.ts'

const COMPOSITION = 'agent.cordis.yml'

async function resolvedPresetFiles(root: string): Promise<Array<{ id: string; path: string }>> {
  const candidates = await readdir(root, { withFileTypes: true }).catch(() => [])
  const output: Array<{ id: string; path: string }> = []
  for (const entry of candidates) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, COMPOSITION)
    if (await stat(path).then((value) => value.isFile()).catch(() => false)) {
      output.push({ id: entry.name, path })
    }
  }
  return output.sort((left, right) => left.id.localeCompare(right.id))
}

function defaultRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

function usage(): never {
  console.error('usage: dsh-arc-presets audit [preset-root]')
  process.exit(64)
}

async function audit(root: string): Promise<number> {
  const presets = await resolvedPresetFiles(root)
  if (presets.length === 0) {
    console.log(`ARC preset audit: no presets under ${root}`)
    return 0
  }
  let failed = 0
  for (const preset of presets) {
    const source = await readFile(preset.path, 'utf8')
    const report = inspectPresetComposition(source)
    const broken = report.issues.length > 0
    const status = broken ? 'FAIL' : report.patchable ? 'PASS' : 'NOTE'
    const detail = broken
      ? report.issues.join('; ')
      : report.hasLocalArc
        ? 'preset selects dsh-arc-context natively; the bridge leaves it untouched'
        : report.patchable
          ? 'official Basic row is bridge-replaceable inside its isolate realm'
          : 'no isolated compaction realm; the preset resolves host-plane compaction and the bridge does not intervene'
    console.log(`${status}\t${preset.id}\t${detail}`)
    if (broken) failed += 1
  }
  console.log(`ARC preset audit: ${presets.length - failed} pass, ${failed} fail`)
  return failed === 0 ? 0 : 2
}

const [command, rootArg] = process.argv.slice(2)
if (command !== 'audit') usage()
const root = rootArg !== undefined && !rootArg.startsWith('--') ? rootArg : defaultRoot()
process.exitCode = await audit(root)
