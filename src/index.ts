/**
 * dsh-arc-context — Adaptive Reversible Context (ARC) for the DeepSeek Harness,
 * delivered as a `CompactionEngine` backend.
 *
 * The model decides when and what to compress (pure ARC semantics):
 *  - the `compress` tool durably shadows a surface range with the model-written
 *    summary (no second LLM summarization call — the ARC cost win);
 *  - the original events stay in the append-only session log, so `decompress`,
 *    `search_context`, and replay always work;
 *  - refs are surface seqs carried by the injected nudge's range table (DSH
 *    has no in-memory message rewrite hook — see docs/dsh-porting-verification.md);
 *  - automatic policy never summarizes by itself: it nudges the model.
 *
 * Mount it wherever a compaction backend is expected:
 *
 * ```yaml
 * - id: compaction-billion-context
 *   name: 'dsh-arc-context'
 *   config:
 *     modelContextLimit: 128000
 * ```
 *
 * The package registers `ctx.compaction` plus the four model tools and the
 * `/arc` command when the hosting composition provides `ctx.tools` /
 * `ctx.commands`.
 * @module dsh-arc-context
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CompactionEngine,
  ManualCompactionError,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { createCore, type CompressionCore } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { ArcStateStore } from './state.ts'
import { makeTools, type BackendOwnership, type ToolEnvironment } from './tools.ts'
import { arcCommand } from './commands.ts'
import { buildNudge } from './nudge.ts'
import { ARC_SYSTEM_PROMPT_ORDER } from './system-prompt.ts'
import { renderSystemPrompt, resolvePrompts, type ArcPrompts, type ResolvedPrompts } from './prompts.ts'
import { DEFAULT_CONTEXT_WINDOW, detectContextWindow, type ArcWindow } from './window.ts'
import {
  governedOutputReserve,
  governedKernelInput,
  governedMaxTokens,
  resolveAdaptiveGovernor,
  shouldRunEmergencyFallback,
  type AdaptiveGovernorConfig,
} from './governor.ts'
import {
  prepareLocalCompaction,
  runEmergencyFallback,
  runLocalCompactionRegion,
} from './fallback.ts'
import {
  buildCompressibleSeqRanges,
  compressionAwareProjectedTokens,
  findOpenTurn,
  runManualCompactionTransaction,
  shadowedSeqsOf,
} from './region.ts'

const ARC_BACKEND_BRAND = Symbol.for('dsh-arc-context.backend')

/**
 * True when `value` is an ARC compaction backend (or a Cordis service facade
 * over one). The structural brand survives duplicated package instances and
 * realm isolation; the bridge and `backendOwnership` both resolve takeover
 * through it.
 * @param value - any service value resolved for `compaction`.
 */
export function isArcBackend(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as { readonly [ARC_BACKEND_BRAND]?: unknown })[ARC_BACKEND_BRAND] === true
}

export { ArcStateStore } from './state.ts'
export { kernelConfigFor, type KernelConfigInput } from './config.ts'
export { ARC_SYSTEM_PROMPT, ARC_SYSTEM_PROMPT_ORDER } from './system-prompt.ts'
export {
  DEFAULT_PROMPTS,
  DEFAULT_RESOLVED,
  renderSystemPrompt,
  renderTemplate,
  resolvePrompts,
  type ArcPrompts,
  type NudgePrompts,
  type PromptInput,
  type PromptOverride,
  type RangeTablePrompts,
  type ResolvedPrompts,
  type ToolPrompts,
} from './prompts.ts'
export { makeTools, type BackendOwnership, type ToolEnvironment } from './tools.ts'
export { arcCommand } from './commands.ts'
export { buildNudge, resolveTokenCount, type NudgeEnvironment, type NudgeOutcome } from './nudge.ts'
export {
  DEFAULT_CONTEXT_WINDOW,
  detectContextWindow,
  windowSourceLabel,
  type ArcWindow,
} from './window.ts'
export {
  DEFAULT_ADAPTIVE_GOVERNOR,
  DEFAULT_AUTO_OUTPUT_TOKENS,
  explicitMaxTokensForAgent,
  governorCapacity,
  governedKernelInput,
  governedMaxTokens,
  governedOutputReserve,
  resolveAdaptiveGovernor,
  shouldRunEmergencyFallback,
  type AdaptiveGovernorConfig,
  type GovernorCapacity,
  type MaxOutputTokensPolicy,
  type OutputIntentContext,
} from './governor.ts'
export {
  buildEmergencyFallbackSummary,
  buildManualFallbackSummary,
  buildModelSummarySafetyIndex,
  prepareLocalCompaction,
  resolveShadowedTokenCount,
  runEmergencyFallback,
  runLocalCompactionRegion,
} from './fallback.ts'
export {
  AlreadyCompressedRangeError,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  runManualCompactionTransaction,
  shadowedSeqsOf,
  findOpenTurn,
  assertNoActiveCompaction,
  blockRegistry,
  blockRefForSummarySeq,
  compactionIdsOfKernelBlocks,
  summarySeqOfKernelBlock,
  expandShadowedSeqs,
  expandEffectiveSourceSeqs,
  type ArcBlockLedgerEntry,
  type CompactionTransactionInput,
  type ResolvedSurfaceRange,
} from './region.ts'
export { eventsToCoreMessages, projectEvent, surfaceEventsOf, extractEventText } from './messages.ts'
export {
  inspectPresetComposition,
  isolatesCompaction,
  type PresetCompatibility,
} from './preset-compat.ts'

export interface ArcConfig {
  /** Refresh tier-2/3 safety appendices from recursively expanded original sources. Default true. */
  readonly effectiveSourceSafetyIndex: boolean
  /** Body-assembly policy for model-checkpoint safety appendices under budget pressure: 'value' | 'chronological'. Default 'value'. */
  readonly safetyIndexRanking: string
  /**
   * The context window used for pressure decisions, in tokens. When omitted,
   * `autoModelContextLimit` (default true) probes the model's real window via
   * `agent.ctx.llm.resolveModelInfo(provider, model)`; an explicit value
   * always wins and disables the probe.
   */
  readonly modelContextLimit?: number
  /** Probe the model's real context window from the LLM runtime. Default true. */
  readonly autoModelContextLimit: boolean
  /** Nudge window lower bound (usage fraction; validation only — the growth-driven trigger has no percentage floor). Kernel default 0.45 — same as billion-context-pi. */
  readonly nudgeMinContextLimitPct?: number
  /**
   * Nudge window upper bound — over-limit guarantee line: above this the
   * kernel injects a nudge regardless of growth or cadence. Engine default
   * 0.70 (deliberately BELOW the kernel/billion-context-pi default 0.75 and
   * the host compaction-basic auto-compaction line 0.80, so the forced nudge
   * always fires first); an explicit value wins.
   */
  readonly nudgeMaxContextLimitPct?: number
  /**
   * Emergency nudge threshold (bypasses the per-turn dedup). Engine default
   * 0.85 (down from the kernel/billion-context-pi default 0.95: 95% leaves
   * the model no room to act before the API rejects, and the host's 80%
   * compaction-basic line shadows it in standard/code/cordis modes).
   */
  readonly nudgeEmergencyThresholdPct?: number
  /** Protected-zone size in trailing messages (never compressible). Kernel default 5.
   *  Larger values are safer for tasks that keep re-reading recent output; smaller
   *  ones free more history but risk compressing content still in active use. */
  readonly protectedRecentMessages?: number
  /** Protected-zone size in trailing tokens (never compressible). Kernel default 5000. */
  readonly protectedRecentTokens?: number
  /** Minimum total original chars for a compressible range. Kernel default 5000.
   *  Lower values let the model compress small spans early; higher values batch
   *  history into fewer, denser blocks. */
  readonly minCompressChars?: number
  /** Nudge cadence: minimum turns between normal (non-emergency) nudges. Kernel default 5.
   *  Raise to make pressure notes rarer; 1 makes every over-threshold turn nudge. */
  readonly nudgeCadenceTurns?: number
  /** Any other acp-kernel Config override (billion-context-pi's `coreOverrides` escape hatch). */
  readonly coreOverrides?: Partial<import('acp-kernel').Config>
  /**
   * Custom token-count function for the kernel's internal estimation.
   * Defaults to the kernel's `defaultCountTokens` (CJK: 1 char = 1 token,
   * other: 4 chars = 1 token — aligns with billion-context-pi).
   * Can be overridden for provider-specific tokenization, e.g. DeepSeek's
   * official coefficient: 1 CJK char ≈ 0.6 tokens, 1 other char ≈ 0.3 tokens.
   * Only affects the kernel's internal estimation (compressible range sizing,
   * nudge text, growth branch pending); the `projectedTokens` reading from
   * `sessionProjections` (used for nudge pressure decisions and arc_status)
   * is provider-anchored and unaffected by this function.
   */
  readonly countTokens?: (text: string) => number
  /** Register the four model tools on `ctx.tools`. Default true. */
  readonly autoTools: boolean
  /** Register the `/arc` command on `ctx.commands`. Default true. */
  readonly autoCommand: boolean
  /** Inject the nudge into `agent/pre-step` when the kernel recommends it. Default true. */
  readonly autoNudge: boolean
  /** Per-stage prompt template overrides (nudge / range table / system prompt / tool descriptions). See docs/configurable-prompts-design.md. */
  readonly prompts?: ArcPrompts
  /**
   * Optional output-reserve-aware governor. It caps excessive completion
   * reserve and replaces eager growth nudges with late pressure nudges against
   * the remaining effective input capacity. Disabled by default while beta.
   */
  readonly adaptiveGovernor?: Partial<AdaptiveGovernorConfig>
}

/** Loader-facing configuration type; programmatic-only countTokens is intentionally omitted. */
export type Config = Omit<Partial<ArcConfig>, 'countTokens'>

const positiveInteger = () => Schema.number().step(1).min(1)
const fraction = () => Schema.number().min(0.000001).max(0.999999)

/**
 * Official Cordis/Schemastery configuration surface. Defaults make a plain
 * package install usable; constructor validation still enforces cross-field
 * relationships such as normal pressure < emergency pressure.
 */
export const Config: Schema<Config> = Schema.object({
  effectiveSourceSafetyIndex: Schema.boolean().default(true).description('Build tier-2/3 model-checkpoint safety appendices from recursive effective sources.'),
  safetyIndexRanking: Schema.string().default('value').description("Eviction order for safety-index body lines when the checkpoint budget is exceeded: 'value' (typed-value density first) or 'chronological'."),
  modelContextLimit: positiveInteger().description('Explicit model context window. Omit to auto-detect.'),
  autoModelContextLimit: Schema.boolean().default(true).description('Use provider/session evidence to detect the context window.'),
  nudgeMinContextLimitPct: fraction().description('Optional ARC nudge lower bound.'),
  nudgeMaxContextLimitPct: fraction().default(0.7).description('ARC forced nudge threshold.'),
  nudgeEmergencyThresholdPct: fraction().default(0.85).description('ARC emergency nudge threshold.'),
  protectedRecentMessages: Schema.number().step(1).min(0).description('Protected zone: trailing messages never compressible. Default 5.'),
  protectedRecentTokens: positiveInteger().description('Protected zone: trailing tokens never compressible. Default 5000.'),
  minCompressChars: positiveInteger().description('Minimum original chars for a compressible range. Default 5000.'),
  nudgeCadenceTurns: Schema.number().step(1).min(1).description('Minimum turns between normal nudges. Default 5.'),
  coreOverrides: Schema.any().description('Advanced acp-kernel overrides.'),
  autoTools: Schema.boolean().default(true).description('Register compress/decompress/search_context/arc_status.'),
  autoCommand: Schema.boolean().default(true).description('Register the /arc command.'),
  autoNudge: Schema.boolean().default(true).description('Inject ARC pressure guidance before model steps.'),
  prompts: Schema.any().description('Advanced prompt-template overrides.'),
  adaptiveGovernor: Schema.object({
    enabled: Schema.boolean().default(false).description('Enable output-aware late pressure and the reversible emergency fuse.'),
    maxOutputTokens: Schema.union([
      'auto',
      positiveInteger(),
    ]).default('auto').description('auto preserves explicit output intent and otherwise uses 32K; a number is a hard cap.'),
    safetyMarginTokens: positiveInteger().default(32768).description('Input safety margin reserved below the context window.'),
    nudgeAtEffectiveCapacityPct: fraction().default(0.75).description('Normal pressure line within effective input capacity.'),
    emergencyAtEffectiveCapacityPct: fraction().default(0.9).description('Emergency fuse line within effective input capacity.'),
    emergencyFallback: Schema.boolean().default(true).description('Enable local reversible cold-storage at emergency pressure.'),
  }).description('Adaptive Reversible Context Governor.'),
})

const DEFAULT_CONFIG: ArcConfig = {
  effectiveSourceSafetyIndex: true,
  safetyIndexRanking: 'value',
  autoModelContextLimit: true,
  autoTools: true,
  autoCommand: true,
  autoNudge: true,
  // Nudge thresholds: engine defaults 0.70/0.85 — deliberately below the
  // kernel/billion-context-pi 0.75/0.95. 0.95 leaves no room to act before
  // the API rejects, and the host's compaction-basic line (thresholdRatio
  // 0.80) shadows it in standard/code/cordis modes; 0.70 keeps the forced
  // over-limit nudge ahead of that 80% line. Explicit values always win.
  nudgeMaxContextLimitPct: 0.7,
  nudgeEmergencyThresholdPct: 0.85,
}

export function resolveArcConfig(config: Partial<ArcConfig> = {}): ArcConfig {
  return { ...DEFAULT_CONFIG, ...config }
}

/**
 * The ARC compaction backend. Subclasses the seam exactly like
 * `dsh-compaction-basic`; swaps summarization-driven compaction for
 * model-driven block compression without touching the agent loop.
 */
export class ArcCompactionEngine extends CompactionEngine {
  /** Cross-scope/cross-module structural brand; Cordis may expose a service facade rather than this exact object. */
  readonly [ARC_BACKEND_BRAND] = true
  /** The framework-agnostic ARC compression core, reused verbatim. */
  readonly kernel: CompressionCore
  /** Per-session kernel state. */
  readonly store: ArcStateStore
  /** Resolved engine configuration. */
  readonly config: ArcConfig
  /** Resolved prompt templates (validated at construction — fail-fast on template typos). */
  readonly prompts: ResolvedPrompts
  /** Resolved output-reserve-aware governor configuration. */
  readonly adaptiveGovernor: AdaptiveGovernorConfig

  private readonly lastNudgeTurn = new Map<string, number>()
  /** One provider-overflow recovery is allowed per step; pre-step resets it. */
  private readonly overflowFallbackUsed = new WeakSet<Agent>()
  /** Per provider/model route the resolved window (probe failures cached too). */
  private readonly windowCache = new Map<string, ArcWindow>()

  /** Identify the effective host or preset-isolated compaction provider for one agent. */
  backendOwnership(agent: Agent): BackendOwnership {
    const presetRegistry = this.ctx.get('agentPresets') as
      | { serviceFor?(owner: Agent, name: 'compaction'): unknown }
      | undefined
    const resolved = presetRegistry?.serviceFor?.(agent, 'compaction')
      ?? agent.ctx.get('compaction') as unknown
    if (resolved === undefined) return { status: 'unknown', resolvedBackend: 'unavailable' }
    if (resolved === this || isArcBackend(resolved)) return { status: 'active', resolvedBackend: 'dsh-arc-context' }
    const name = typeof resolved === 'object' && resolved !== null
      ? resolved.constructor?.name ?? 'anonymous object'
      : typeof resolved
    return { status: 'shadowed', resolvedBackend: name }
  }

  /** Governor must never run as a silent hybrid beside a nearer preset backend. */
  assertActiveBackend(agent: Agent): void {
    const ownership = this.backendOwnership(agent)
    if (ownership.status !== 'shadowed') return
    throw new Error(
      `dsh-arc-context: preset backend ${ownership.resolvedBackend} was not replaced by the in-realm row swap; `
      + 'verify the dsh-arc-context/bridge row and the preset composition, then run dsh-arc-presets audit',
    )
  }

  private projectedContextWindow(session: unknown): number | undefined {
    const projections = this.ctx.get('sessionProjections') as
      | { snapshot?: (value: unknown) => { values?: { contextPressure?: { contextWindow?: number } } } }
      | undefined
    const window = projections?.snapshot?.(session)?.values?.contextPressure?.contextWindow
    return typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : undefined
  }

  private projectedContext(agent: CompactionAgentContext): { projectedTokens: number; contextWindow: number } | null {
    const projections = this.ctx.get('sessionProjections') as
      | { snapshot?: (session: unknown) => { values?: { contextPressure?: {
        projectedTokens?: number
        contextWindow?: number
      } } } }
      | undefined
    const pressure = projections?.snapshot?.(agent.session)?.values?.contextPressure
    if (typeof pressure?.projectedTokens !== 'number' || pressure.projectedTokens <= 0) return null
    const cached = this.windowCache.get(`${agent.options.provider ?? ''}\0${agent.options.model ?? ''}`)
    const contextWindow = this.config.modelContextLimit
      ?? this.projectedContextWindow(agent.session)
      ?? cached?.limit
      ?? DEFAULT_CONTEXT_WINDOW
    return {
      projectedTokens: compressionAwareProjectedTokens(
        agent.session,
        pressure.projectedTokens,
        (message) => this.ctx.logger.debug(message),
      ),
      contextWindow,
    }
  }

  constructor(ctx: Context, config: Partial<ArcConfig> = {}) {
    super(ctx)
    this.config = resolveArcConfig(config)
    this.adaptiveGovernor = resolveAdaptiveGovernor(config.adaptiveGovernor)
    // Resolve + validate prompt templates BEFORE building env: a template typo
    // must fail engine construction, never silently leak into model context.
    this.prompts = resolvePrompts(config.prompts)
    const ports = this.config.countTokens !== undefined ? { countTokens: this.config.countTokens } : {}
    this.kernel = createCore(ports)
    this.store = new ArcStateStore()

    const env: ToolEnvironment = {
      kernel: this.kernel,
      store: this.store,
      effectiveSourceSafetyIndex: this.config.effectiveSourceSafetyIndex,
      safetyIndexRanking: this.config.safetyIndexRanking,
      // Initial value before any probe; windowFor() replaces it per pre-step.
      modelContextLimit: this.config.modelContextLimit ?? DEFAULT_CONTEXT_WINDOW,
      nudgeMinContextLimitPct: this.config.nudgeMinContextLimitPct,
      nudgeMaxContextLimitPct: this.config.nudgeMaxContextLimitPct,
      nudgeEmergencyThresholdPct: this.config.nudgeEmergencyThresholdPct,
      protectedRecentMessages: this.config.protectedRecentMessages,
      protectedRecentTokens: this.config.protectedRecentTokens,
      minCompressChars: this.config.minCompressChars,
      nudgeCadenceTurns: this.config.nudgeCadenceTurns,
      coreOverrides: this.config.coreOverrides,
      windowFor: (agent) => this.windowFor(agent),
      prompts: this.prompts,
      backendOwnership: (agent) => this.backendOwnership(agent),
    }

    // The provider adapter may advertise an extremely large completion cap
    // (256K in the measured 1M DeepSeek route). Since providers validate
    // input + reserved output before generation, that default can reject a
    // ~793K input even though the model still has ample practical headroom.
    // Governor mode installs an explicit, durable ordinary-request budget.
    // Auto mode uses 32K only when the conversation expressed no output
    // intent; an explicit long-output cap is preserved and pressure geometry
    // moves earlier to reserve it. Numeric mode remains a hard operator cap.
    if (this.adaptiveGovernor.enabled) {
      ctx.on('agent/request', async (payload, next) => {
        this.assertActiveBackend(payload.agent)
        const request = await next()
        const maxTokens = governedMaxTokens(request.maxTokens, this.adaptiveGovernor)
        return maxTokens === request.maxTokens ? request : { ...request, maxTokens }
      })
    }

    // CompactionEngine is only a service seam: unlike BasicCompactionEngine,
    // it does not install pressure/overflow listeners for subclasses. ARC is
    // also commonly mounted beside a realm-local Basic engine with `auto:
    // false`, so waiting for an external caller leaves the governor fuse
    // unreachable. Own both host boundaries here. The pressure listener runs
    // before `next()` so a landed replacement is visible when AgentLoop later
    // derives the request. Overflow retries only after replaceGeneration
    // proves durable surface progress, and at most once per proposed step.
    if (this.adaptiveGovernor.enabled && this.adaptiveGovernor.emergencyFallback) {
      ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        this.assertActiveBackend(agent)
        this.overflowFallbackUsed.delete(agent)
        if (!signal.aborted) {
          try {
            await this.compactIfNeeded(agent, 'pressure', signal)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.warn(`adaptive governor pressure fallback failed: ${message}; continuing the step`)
          }
        }
        return next()
      })
      ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
        this.assertActiveBackend(agent)
        if (
          failure.code !== 'CONTEXT_WINDOW_EXCEEDED'
          || signal.aborted
          || this.overflowFallbackUsed.has(agent)
        ) return next()
        const generation = agent.session.surface.replaceGeneration
        try {
          await this.compactIfNeeded(agent, 'context-overflow', signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`adaptive governor overflow fallback failed: ${message}; preserving the request error`)
          return next()
        }
        if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
        this.overflowFallbackUsed.add(agent)
        return { kind: 'retry' }
      })
    }

    // Tools and commands may not be registered yet on cold start: cordis
    // starts unrelated composition rows concurrently, so the first
    // `ctx.get('tools')` can legitimately be undefined even though the row
    // ships later in the file. HMR-style reloads always see them (already
    // present), but a fresh process races — the tools silently vanished on
    // restart. Register eagerly, then re-attempt when the service appears
    // (`internal/service`) or the app finishes booting (`ready`); guard so a
    // late callback never double-registers.
    const tools = ctx.get('tools')
    if (tools !== undefined) {
      for (const tool of makeTools(env)) tools.register(tool)
    } else {
      let done = false
      const registerTools = (): void => {
        if (done) return
        const registry = ctx.get('tools')
        if (registry === undefined) return
        done = true
        for (const tool of makeTools(env)) registry.register(tool)
      }
      ctx.on('internal/service', (name: unknown) => {
        if (name === 'tools') registerTools()
      })
    }
    const commands = ctx.get('commands')
    if (commands !== undefined) {
      commands.register(arcCommand(env))
    } else {
      let done = false
      const registerCommand = (): void => {
        if (done) return
        const registry = ctx.get('commands')
        if (registry === undefined) return
        done = true
        registry.register(arcCommand(env))
      }
      ctx.on('internal/service', (name: unknown) => {
        if (name === 'commands') registerCommand()
      })
    }
    if (this.config.autoNudge) {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        const window = await this.windowFor(payload.agent)
        const outputReserve = this.adaptiveGovernor.enabled
          ? governedOutputReserve(payload.agent, this.adaptiveGovernor)
          : undefined
        const kernelInput = governedKernelInput(
          { ...env, modelContextLimit: window.limit },
          this.adaptiveGovernor,
          outputReserve,
        )
        const outcome = buildNudge(payload.agent, { ...env, ...kernelInput }, this.lastNudgeTurn)
        if (outcome === null) return decision
        return { kind: 'enter', messages: [...decision.messages, outcome.message] }
      })
    }
    // The load-bearing ARC guidance lives in the system prompt ONCE; nudges
    // stay short and advisory (model-driven: the model decides). The
    // systemPrompt service may not be registered yet on cold start (cordis
    // starts unrelated composition rows concurrently), so apply the same
    // retry pattern as tools and commands: eager registration, then
    // re-attempt when the service appears via `internal/service`; guard so a
    // late callback never double-registers.
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      systemPrompt.section({
        name: 'dsh-arc-context',
        order: ARC_SYSTEM_PROMPT_ORDER,
        text: renderSystemPrompt(this.prompts),
      })
    } else {
      let done = false
      const registerSystemPrompt = (): void => {
        if (done) return
        const registry = ctx.get('systemPrompt')
        if (registry === undefined) return
        done = true
        registry.section({
          name: 'dsh-arc-context',
          order: ARC_SYSTEM_PROMPT_ORDER,
          text: renderSystemPrompt(this.prompts),
        })
      }
      ctx.on('internal/service', (name: unknown) => {
        if (name === 'systemPrompt') registerSystemPrompt()
      })
    }
  }

  /**
   * Resolve the effective context window for an agent. An explicitly
   * configured `modelContextLimit` always wins (no probe). Otherwise probe the
   * model's real window via `agent.ctx.llm.resolveModelInfo` (cached per
   * provider/model route, probe failures cached too) and fall back to
   * DEFAULT_CONTEXT_WINDOW when auto-detection is disabled or unavailable.
   */
  async windowFor(agent: Agent): Promise<ArcWindow> {
    if (this.config.modelContextLimit !== undefined) {
      return { limit: this.config.modelContextLimit, source: 'explicit' }
    }
    const provider = agent.options.provider ?? ''
    const model = agent.options.model ?? ''
    const key = `${provider}\0${model}`
    let window: ArcWindow
    if (!this.config.autoModelContextLimit) {
      window = { limit: DEFAULT_CONTEXT_WINDOW, source: 'default', provider, model }
    } else {
      // Once the host has assembled a real request, its context-pressure
      // projection is route/adapter anchored and therefore stronger evidence
      // than an advisory model-info probe. Check it before the route cache so
      // a first-step provisional probe can be corrected on the next step.
      const projected = this.projectedContextWindow(agent.session)
      if (projected !== undefined) {
        window = { limit: projected, source: 'auto', provider, model }
        this.windowCache.set(key, window)
        return window
      }
      const cached = this.windowCache.get(key)
      if (cached !== undefined) return cached
      const detected = await detectContextWindow(agent, provider, model)
      window = detected === null
        ? { limit: DEFAULT_CONTEXT_WINDOW, source: 'default', provider, model }
        : { limit: detected, source: 'auto', provider, model }
    }
    this.windowCache.set(key, window)
    return window
  }

  /**
   * Normal operation stays model-driven. Governor mode adds one model-free,
   * reversible emergency path: at its emergency line (or after a confirmed
   * provider overflow), archive one old balanced range into ARC cold-storage.
   */
  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (!this.adaptiveGovernor.enabled || !this.adaptiveGovernor.emergencyFallback) return null
    if (trigger === 'pressure') {
      const pressure = this.projectedContext(agent)
      if (pressure === null) return null
      const outputReserve = governedOutputReserve(agent, this.adaptiveGovernor)
      if (!shouldRunEmergencyFallback(
        trigger,
        pressure.projectedTokens,
        pressure.contextWindow,
        this.adaptiveGovernor,
        outputReserve,
      )) return null
    } else if (!shouldRunEmergencyFallback(
      trigger,
      null,
      this.config.modelContextLimit ?? DEFAULT_CONTEXT_WINDOW,
      this.adaptiveGovernor,
    )) {
      return null
    }
    signal.throwIfAborted()
    return runEmergencyFallback(agent)
  }

  /** Explicit idle-session compaction through a local reversible checkpoint. */
  override compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = buildCompressibleSeqRanges(agent.session, { preserveRecent: 0 })[0]
          if (range === undefined) return null
          const shadowedSeqs = shadowedSeqsOf(agent.session, range.start, range.end)
          if (shadowedSeqs.length === 0) return null
          const sessions = this.ctx.get('sessions') as
            | { flush(session: ManualCompactAgentContext['session']): Promise<void> }
            | undefined
          return await runManualCompactionTransaction(
            agent.session,
            { start: range.start, end: range.end, shadowedSeqs },
            () => {
              const input = prepareLocalCompaction(agent, range.start, range.end)
              if (input === null) {
                throw new ManualCompactionError('summary', 'manual ARC checkpoint would not reduce context')
              }
              return input
            },
            operationSignal,
            sourceCommandId,
            sessions === undefined ? undefined : () => sessions.flush(agent.session),
          )
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual ARC compaction was cancelled', { cause: error })
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error) {
      throw new ManualCompactionError(
        'busy',
        'manual ARC compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /**
   * Compact one caller-selected range with a bounded local reversible
   * checkpoint. No auxiliary LLM call is made.
   */
  override async compactRegion(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted()
    if (findOpenTurn(agent.session.events) === null) {
      throw new Error('dsh-arc-context: compactRegion requires an open turn')
    }
    const result = runLocalCompactionRegion(agent, start, end)
    if (result === null) {
      throw new Error('dsh-arc-context: selected range is not larger than its local reversible checkpoint')
    }
    return result
  }
}

/** Product-facing name. The ARC name remains exported for source compatibility. */
export { ArcCompactionEngine as ArcContextEngine }

export default ArcCompactionEngine
