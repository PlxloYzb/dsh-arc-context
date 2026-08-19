import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectPresetComposition } from '../src/preset-compat.ts'

const official = `
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
`

test('preset compatibility accepts host-inherited compaction', () => {
  const report = inspectPresetComposition(official
    .replace('    compaction: true\n', '')
    .replace("    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'\n\n", ''))
  assert.equal(report.inheritsHostCompaction, true)
  assert.equal(report.patchable, false, 'no isolated realm means the bridge does not intervene')
  assert.deepEqual(report.issues, [])
})

test('preset compatibility marks the official Basic row bridge-patchable', () => {
  const report = inspectPresetComposition(official)
  assert.equal(report.hasLocalBasic, true)
  assert.equal(report.isolatesCompaction, true)
  assert.equal(report.inheritsHostCompaction, false)
  assert.equal(report.patchable, true)
  assert.deepEqual(report.issues, [])
})

test('preset compatibility flags an isolated realm with a foreign backend', () => {
  const report = inspectPresetComposition(official.replace(
    "    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'\n",
    "    - id: custom\n      name: '@example/custom-compaction'\n",
  ))
  assert.equal(report.inheritsHostCompaction, false)
  assert.equal(report.patchable, false)
  assert.ok(report.issues.length > 0)
})

test('preset compatibility accepts a natively-ARC composition', () => {
  const report = inspectPresetComposition(official.replace(
    "'@deepseek-ai/dsh-compaction-basic'",
    'dsh-arc-context',
  ))
  assert.equal(report.hasLocalArc, true)
  assert.equal(report.patchable, true)
  assert.deepEqual(report.issues, [])
})

test('preset compatibility rejects both backends in one realm', () => {
  const report = inspectPresetComposition(official.replace(
    "    - id: command-compact\n      name: '@deepseek-ai/dsh-command-compact'\n",
    "    - id: compaction-arc\n      name: 'dsh-arc-context'\n",
  ))
  assert.ok(report.hasLocalBasic && report.hasLocalArc)
  assert.ok(report.issues.length > 0)
})
