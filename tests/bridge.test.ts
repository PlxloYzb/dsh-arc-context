/**
 * Bridge integration tests against the REAL published Loader, Include, and
 * Group packages (the exact versions the rc.7 harness runs): a preset
 * composition file mirroring the official `compaction` group is mounted
 * through a real loader tree, and the bridge's in-realm row swap must hold
 * end to end — Basic disabled inside its realm, the ARC engine provided
 * there, sibling consumers rebound, everything reverted on rollback with
 * the preset file byte-identical throughout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { ArcCompactionEngine, isArcBackend } from '../src/index.ts'
import { apply as applyBridge, buildTakeoverPatches, rollbackMount, takeoverMount } from '../src/bridge.ts'

/** The official standard-preset compaction group, verbatim in structure. */
const PRESET_YAML = `\
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
`

class FakeBasic extends Service {
  static inject = []
  constructor(ctx: Context) {
    super(ctx, 'compaction')
  }
}

/** Sibling consumer (command-compact stand-in): records its realm's compaction per activation. */
class FakeConsumer extends Service {
  static inject = ['compaction']
  static instances: FakeConsumer[] = []
  readonly resolved: unknown
  constructor(ctx: Context) {
    super(ctx, 'consumer-probe')
    this.resolved = ctx.compaction
    FakeConsumer.instances.push(this)
  }
}

interface MountedPreset {
  ctx: Context
  cleanup: () => Promise<void>
  fiber: Fiber
  source: string
  path: string
}

async function mountPreset(yaml: string, extraModules: Record<string, unknown> = {}): Promise<MountedPreset> {
  const dir = await mkdtemp(join(tmpdir(), 'arc-bridge-'))
  const path = join(dir, 'agent.cordis.yml')
  await writeFile(path, yaml, 'utf8')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  // What the bridge row's apply() publishes on a real host: the engine class
  // behind the `cordis:dsh-arc-context` row name (see the apply test below).
  ctx.loader.builtins['dsh-arc-context'] = ArcCompactionEngine
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-compaction-basic', FakeBasic],
    ['@deepseek-ai/dsh-command-compact', FakeConsumer],
    ...Object.entries(extraModules),
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(path).href },
  })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(candidate => candidate.subtree !== undefined)
  const fiber = entry?.fiber
  if (fiber === undefined) throw new Error('preset include entry did not activate')
  return {
    ctx,
    fiber,
    path,
    source: yaml,
    cleanup: async () => {},
  }
}

function latestConsumer(): FakeConsumer {
  const last = FakeConsumer.instances.at(-1)
  assert.ok(last !== undefined, 'consumer probe activated')
  return last
}

test('bridge: takeover swaps Basic for ARC inside the preset realm', async () => {
  FakeConsumer.instances = []
  const preset = await mountPreset(PRESET_YAML)
  try {
    const before = latestConsumer()
    assert.ok(before.resolved instanceof FakeBasic, 'realm compaction starts as the official Basic row')

    const tracked = new Map()
    const status = await takeoverMount(preset.ctx, {}, { presetId: 'standard', fiber: preset.fiber }, tracked)
    assert.equal(status, 'taken-over')

    const after = latestConsumer()
    assert.ok(after.resolved instanceof ArcCompactionEngine, 'sibling consumer rebinds to the ARC engine row')
    assert.ok(isArcBackend(after.resolved), 'rebound backend carries the ARC structural brand')
    assert.equal(preset.ctx.get('compaction'), undefined, 'the root plane still sees no compaction service')
    assert.equal(tracked.size, 1, 'the mount is tracked for effect-owned rollback')

    const fileAfter = await readFile(preset.path, 'utf8')
    assert.equal(fileAfter, PRESET_YAML, 'the preset file stays byte-identical')
  } finally {
    await preset.cleanup()
  }
})

test('bridge: rollback restores the official Basic row and the original Include config', async () => {
  FakeConsumer.instances = []
  const preset = await mountPreset(PRESET_YAML)
  try {
    const tracked = new Map()
    assert.equal(
      await takeoverMount(preset.ctx, {}, { presetId: 'standard', fiber: preset.fiber }, tracked),
      'taken-over',
    )
    assert.ok(latestConsumer().resolved instanceof ArcCompactionEngine)

    await rollbackMount(preset.fiber, tracked)
    assert.equal(tracked.size, 0)
    const restored = latestConsumer()
    assert.ok(restored.resolved instanceof FakeBasic, 'rollback re-enables the official Basic row in-realm')

    const include = preset.fiber.config as { patches?: unknown }
    assert.equal('patches' in include, false, 'the Include config object is back to its original shape')
    assert.equal(await readFile(preset.path, 'utf8'), PRESET_YAML)
  } finally {
    await preset.cleanup()
  }
})

test('bridge: a second takeover of the same mount is idempotent', async () => {
  FakeConsumer.instances = []
  const preset = await mountPreset(PRESET_YAML)
  try {
    const tracked = new Map()
    const mount = { presetId: 'standard', fiber: preset.fiber }
    assert.equal(await takeoverMount(preset.ctx, {}, mount, tracked), 'taken-over')
    assert.equal(await takeoverMount(preset.ctx, {}, mount, tracked), 'taken-over')
    assert.equal(tracked.size, 1)
    const consumers = FakeConsumer.instances.filter(instance => instance.resolved instanceof ArcCompactionEngine)
    assert.equal(consumers.length, 1, 'no duplicate ARC row was ever inserted')
  } finally {
    await preset.cleanup()
  }
})

test('bridge: name guards leave a non-Basic compaction backend untouched', async () => {
  FakeConsumer.instances = []
  const custom = PRESET_YAML.replace(
    "name: '@deepseek-ai/dsh-compaction-basic'",
    "name: 'third-party-compaction'",
  )
  const thirdParty = class extends Service {
    static inject = []
    constructor(ctx: Context) {
      super(ctx, 'compaction')
    }
  }
  const preset = await mountPreset(custom, { 'third-party-compaction': thirdParty })
  try {
    const before = latestConsumer()
    assert.ok(before.resolved instanceof thirdParty)

    const tracked = new Map()
    const status = await takeoverMount(preset.ctx, {}, { presetId: 'custom', fiber: preset.fiber }, tracked)
    assert.equal(status, 'no-basic-row', 'the disable guard does not match a foreign backend row')
    assert.equal(tracked.size, 0, 'nothing is tracked for a preset the bridge does not recognize')
    assert.ok(latestConsumer().resolved instanceof thirdParty, 'the foreign backend keeps serving its realm')
    const include = preset.fiber.config as { patches?: unknown }
    assert.equal('patches' in include, false, 'the reverted config carries no bridge patches')
    assert.equal(await readFile(preset.path, 'utf8'), custom)
  } finally {
    await preset.cleanup()
  }
})

test('bridge: a preset already selecting ARC natively is left untouched', async () => {
  FakeConsumer.instances = []
  const preset = await mountPreset(PRESET_YAML.replace(
    "name: '@deepseek-ai/dsh-compaction-basic'",
    "name: 'dsh-arc-context'",
  ), { 'dsh-arc-context': ArcCompactionEngine })
  try {
    // The preset imports 'dsh-arc-context' through the fake module registry;
    // the real engine class stands in for the row's plugin.
    const tracked = new Map()
    const status = await takeoverMount(preset.ctx, {}, { presetId: 'arc-native', fiber: preset.fiber }, tracked)
    assert.equal(status, 'already-arc')
    assert.equal(tracked.size, 0)
  } finally {
    await preset.cleanup()
  }
})

test('bridge: apply registers the engine as a loader builtin and retracts it on dispose', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader)
  class FakeAgentPresets extends Service {
    constructor(context: Context) {
      super(context, 'agentPresets')
    }
  }
  await ctx.plugin(FakeAgentPresets)
  const loader = ctx.get('loader') as { builtins: Record<string, unknown> }
  const fiber = await ctx.plugin((context: Context) => {
    applyBridge(context, {})
  })
  assert.equal(loader.builtins['dsh-arc-context'], ArcCompactionEngine)
  assert.deepEqual(
    buildTakeoverPatches({}).map(patch => ({ id: patch.id, name: patch.name, disabled: patch.disabled })),
    [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
      { id: 'compaction', name: undefined, disabled: undefined },
    ],
    'patches disable exactly the official Basic row and insert into the unchanged group',
  )
  await fiber.dispose()
  assert.equal('dsh-arc-context' in loader.builtins, false)
})
