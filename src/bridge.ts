/**
 * dsh-arc-context preset bridge — replace a mounted preset's official Basic
 * compaction backend with ARC inside its original service realm, through
 * official Loader patch semantics and zero file writes.
 *
 * Mechanism (every step is a public, documented Loader/Include behavior):
 *
 *  1. the bridge row (inserted by this package's `cordis.patch.yml` bundle
 *     layer) registers the engine class in the Loader's public builtin
 *     registry, the same registry app-boot itself uses for `cordis:group`;
 *  2. on every `agent/created`, the standing preset mount of the agent's
 *     scope is located through the public `standingMountFor()` export of
 *     `@deepseek-ai/dsh-agent-presets`;
 *  3. the mount's Include config gains runtime patches — disable the
 *     `compaction-basic` row (guarded by its official package name) and
 *     insert the ARC engine row into the unchanged `compaction` isolate
 *     group — then `fiber.update(config, true)` re-reads the composition,
 *     re-applies the patches, and reconciles the tree transactionally;
 *  4. the group keeps its `isolate: { compaction: true }` realm, so the ARC
 *     engine provides `ctx.compaction` exactly where Basic did and the
 *     sibling rows (`command-compact`, `tool-result-pruner`) rebind to it
 *     without any change of their own.
 *
 * Nothing is ever written to disk: preset files, row ids, group nesting, and
 * user patches stay byte-identical, and both uninstall and a plain restart
 * remount the untouched original composition. The fiber mutation is owned by
 * a Cordis effect whose reverse update restores the original Include config
 * (the same transactional re-apply, run backwards).
 *
 * @module dsh-arc-context/bridge
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ArcCompactionEngine, { Config, isArcBackend, type Config as ArcConfig } from './index.ts'

/** Loader builtin key the engine class is published under. */
const BUILTIN_KEY = 'dsh-arc-context'
/** Composition row name that mounts the engine through the builtin registry. */
const BUILTIN_ROW_NAME = `cordis:${BUILTIN_KEY}`
/** Official preset composition ids, stable across the standard/code/cordis presets. */
const COMPACTION_GROUP_ID = 'compaction'
const BASIC_ROW_ID = 'compaction-basic'
const BASIC_ROW_NAME = '@deepseek-ai/dsh-compaction-basic'
/** Row id of the inserted engine row inside the compaction group. */
const ARC_ROW_ID = 'compaction-arc'

/** Structural loader patch shape (`PatchOptions` without the type-only dependency). */
interface EntryPatch {
  readonly id: string
  readonly name?: string
  readonly disabled?: boolean
  readonly insert?: ReadonlyArray<Record<string, unknown>>
}

/** Live Include config of a preset mount. */
interface PresetIncludeConfig {
  readonly path: string
  patches?: EntryPatch[]
  readonly [key: string]: unknown
}

/** One patched preset mount, restorable by effect-owned teardown. */
interface TrackedMount {
  readonly config: PresetIncludeConfig
  readonly hadPatches: boolean
  readonly originalPatches: EntryPatch[] | undefined
}

/** A standing preset mount as the bridge addresses it. */
export interface PresetMountHandle {
  readonly presetId: string
  readonly fiber: Fiber
}

/** Outcome of one takeover attempt. */
export type TakeoverStatus =
  | 'taken-over'
  | 'already-arc'
  | 'no-basic-row'
  | 'unrecognized-carrier'

/**
 * Patches that swap Basic for ARC inside the preset's own compaction realm:
 * the name guard means only the official Basic row is ever disabled, and the
 * insert keeps the group (and therefore its isolate map) untouched.
 * @param config - ARC engine config applied to the inserted row.
 * @returns the patch list to append to the mount's Include config.
 */
export function buildTakeoverPatches(config: ArcConfig): [EntryPatch, EntryPatch] {
  return [
    { id: BASIC_ROW_ID, name: BASIC_ROW_NAME, disabled: true },
    {
      id: COMPACTION_GROUP_ID,
      insert: [{ id: ARC_ROW_ID, name: BUILTIN_ROW_NAME, config: config as Record<string, unknown> }],
    },
  ]
}

function restorePatches(config: PresetIncludeConfig, hadPatches: boolean, original: EntryPatch[] | undefined): void {
  if (hadPatches) {
    config.patches = original
  } else {
    delete config.patches
  }
}

/**
 * Whether `start` belongs to the context subtree of `root`. For loader trees
 * the entry contexts chain through context prototypes (`_patchContext`
 * re-parents them with `setPrototypeOf`), so membership is a prototype-chain
 * walk from the impl's fiber context up to the mount fiber's context.
 */
function withinContext(start: Context | undefined, root: Context): boolean {
  let current: unknown = start
  for (let hops = 0; current !== undefined && current !== null && hops < 100; hops += 1) {
    if (current === root) return true
    current = Object.getPrototypeOf(current)
  }
  return false
}

/**
 * The service one preset mount publishes under `name`, or undefined. This is
 * the ownership relation `AgentPresets.serviceFor` reads (impl.name match
 * with the impl's fiber inside the mount fiber), mirrored locally so the
 * bridge stays testable against a bare Loader and works without a live
 * agent-presets service instance.
 * @param ctx - any context of the runtime whose service store is inspected.
 * @param mount - the standing mount to look inside.
 * @param name - the service name as the preset's rows resolve it.
 */
function serviceWithin(ctx: Context, mount: PresetMountHandle, name: string): unknown {
  const root = mount.fiber.ctx
  const store = ctx.reflect.store
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key] as { name?: string; fiber?: Fiber; value?: unknown } | undefined
    if (impl === undefined || impl.name !== name) continue
    if (withinContext(impl.fiber?.ctx, root)) return impl.value
  }
  return undefined
}

/**
 * Swap one standing preset mount's compaction backend in-realm. The mount's
 * live Include config object is mutated in place — never replaced — so the
 * tree keeps its original config identity (the harness-base record for bare
 * `@deepseek-ai/*` imports is keyed by that object).
 *
 * The swap runs as TWO sequential Include updates, not one: a group update
 * force-restarts every unchanged sibling row, so retiring Basic and mounting
 * ARC in the same update would race Basic's re-construction against the
 * engine's service registration inside the realm. Sequential updates give
 * the ordering the concurrent reconcile cannot: phase 1 disables the Basic
 * row (nothing new starts), phase 2 inserts the engine row into the vacated
 * realm.
 *
 * @param ctx - the bridge's Cordis context.
 * @param config - ARC engine config applied to the inserted row.
 * @param mount - the standing preset mount to patch.
 * @param tracked - effect-owned registry of patched mounts (restored on dispose).
 * @returns the takeover outcome; `fiber.update` failures propagate after
 *          in-place rollback of the config mutation.
 */
export async function takeoverMount(
  ctx: Context,
  config: ArcConfig,
  mount: PresetMountHandle,
  tracked: Map<Fiber, TrackedMount>,
): Promise<TakeoverStatus> {
  if (tracked.has(mount.fiber)) return 'taken-over'
  if (isArcBackend(serviceWithin(ctx, mount, 'compaction'))) return 'already-arc'
  const include = mount.fiber.config as PresetIncludeConfig | undefined
  if (typeof include?.path !== 'string') return 'unrecognized-carrier'

  const hadPatches = Object.hasOwn(include, 'patches')
  const originalPatches = include.patches
  const base = Array.isArray(originalPatches) ? originalPatches : []
  const [retireBasic, mountArc] = buildTakeoverPatches(config)
  // Reverse of the takeover, same two-phase ordering: withdraw the engine row
  // first (Basic stays disabled), then re-enable Basic in the vacated realm.
  const revert = async (): Promise<void> => {
    tracked.delete(mount.fiber)
    if (mount.fiber.uid === null) {
      restorePatches(include, hadPatches, originalPatches)
      return
    }
    try {
      include.patches = [...base, retireBasic]
      await mount.fiber.update(include, true)
    } finally {
      restorePatches(include, hadPatches, originalPatches)
      await mount.fiber.update(include, true)
    }
  }

  include.patches = [...base, retireBasic]
  tracked.set(mount.fiber, { config: include, hadPatches, originalPatches })
  try {
    await mount.fiber.update(include, true)
    // The name guard did not match: a foreign backend still owns the realm,
    // and inserting ARC beside it would collide. Leave the preset untouched.
    const serving = serviceWithin(ctx, mount, 'compaction')
    if (serving !== undefined && !isArcBackend(serving)) {
      await revert()
      return 'no-basic-row'
    }
    include.patches = [...base, retireBasic, mountArc]
    await mount.fiber.update(include, true)
  } catch (error) {
    await revert()
    throw error
  }
  if (isArcBackend(serviceWithin(ctx, mount, 'compaction'))) return 'taken-over'

  // The guards no-op'd: the composition does not carry the official rows (a
  // custom backend or a foreign layout). Undo both phases and report.
  await revert()
  return 'no-basic-row'
}

/**
 * Revert one patched mount with the same two-phase ordering, run backwards:
 * first remove the inserted engine row (Basic stays disabled, so the engine
 * leaves the realm unopposed), then re-enable the official Basic row in the
 * vacated realm.
 * @param fiber - the standing mount's Include fiber previously patched.
 * @param tracked - the effect-owned registry of patched mounts.
 */
export async function rollbackMount(fiber: Fiber, tracked: Map<Fiber, TrackedMount>): Promise<void> {
  const record = tracked.get(fiber)
  if (record === undefined) return
  tracked.delete(fiber)
  const { config, hadPatches, originalPatches } = record
  if (fiber.uid === null) {
    restorePatches(config, hadPatches, originalPatches)
    return
  }
  try {
    config.patches = config.patches?.filter(patch => patch.insert === undefined) ?? []
    await fiber.update(config, true)
  } finally {
    restorePatches(config, hadPatches, originalPatches)
    await fiber.update(config, true)
  }
}

export const name = 'dsh-arc-context-bridge'
export const inject = ['loader']
export { Config }

/**
 * Install the preset bridge. The engine is published as a loader builtin for
 * preset rows, every agent creation swaps its standing preset's Basic row for
 * ARC in-realm, and disposing the bridge fiber first reverts every patched
 * mount (transactional re-apply of the original Include config) and then
 * removes the builtin registration. A process restart reaches the same
 * unpatched state from the untouched files.
 *
 * @param ctx - host context carrying the public Loader and agent-presets services.
 * @param config - ARC configuration applied to every replaced Basic row.
 */
export function apply(ctx: Context, config: ArcConfig): void {
  const loader = ctx.get('loader') as { builtins: Record<string, unknown> }
  loader.builtins[BUILTIN_KEY] = ArcCompactionEngine
  ctx.effect(() => () => {
    if (loader.builtins[BUILTIN_KEY] === ArcCompactionEngine) delete loader.builtins[BUILTIN_KEY]
  }, 'dsh-arc-context.builtin-engine')

  const tracked = new Map<Fiber, TrackedMount>()
  // Registered before the agent listener so LIFO teardown removes the
  // listener first; the rollback therefore cannot observe a fresh takeover.
  ctx.effect(() => async () => {
    const errors: unknown[] = []
    for (const [fiber] of [...tracked.entries()].reverse()) {
      try {
        await rollbackMount(fiber, tracked)
      } catch (error) {
        errors.push(error)
      }
    }
    tracked.clear()
    if (errors.length > 0) {
      throw new AggregateError(errors, 'dsh-arc-context: preset bridge rollback failed')
    }
  }, 'dsh-arc-context.preset-bridge-rollback')

  const logger = ctx.logger('dsh-arc-context')
  let reportedBareHost = false
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    // Hosts without agent-presets (e.g. the headless composition) mount
    // compaction on the root plane; the bridge only swaps preset realms.
    if (ctx.get('agentPresets') === undefined) {
      if (!reportedBareHost) {
        reportedBareHost = true
        logger.info(
          'host composition mounts no agent presets; ARC takeover does not apply '
          + '(the root-plane compaction backend is left unchanged)',
        )
      }
      return
    }
    void Promise.resolve(import('@deepseek-ai/dsh-agent-presets')).then(
      ({ standingMountFor: resolve }) => {
        const mount = resolve(agent.ctx)
        if (mount === undefined) return
        return takeoverMount(ctx, config, mount, tracked).then(
          (status) => {
            if (status === 'no-basic-row') {
              logger.warn(
                `preset ${mount.presetId} does not mount the official compaction-basic row; `
                + 'ARC left it unchanged (run dsh-arc-presets audit)',
              )
            } else if (status === 'unrecognized-carrier') {
              logger.warn(
                `preset ${mount.presetId} has no Include config carrier; `
                + 'ARC left it unchanged (run dsh-arc-presets audit)',
              )
            }
          },
          (error: unknown) => {
            logger.error(`preset ${mount.presetId}: in-realm ARC takeover failed and rolled back: ${String(error)}`)
          },
        )
      },
      (error: unknown) => {
        logger.error(`dsh-arc-context: cannot load @deepseek-ai/dsh-agent-presets: ${String(error)}`)
      },
    )
  })
}
