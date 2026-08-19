/**
 * Adaptive Context Governor — output-reserve-aware pressure policy for ARC.
 *
 * The original ARC kernel is intentionally eager: a fixed 50K growth branch
 * can nudge at ~5-10% of a 1M window. That is useful for proving the mechanism,
 * but long-session measurements show repeated surface rewrites can cost more
 * uncached input than they save while the window still has ample headroom.
 *
 * Governor mode changes only the policy, not the reversible ARC storage:
 * - cap an excessive adapter default output reserve;
 * - derive the input budget left after output reserve and a safety margin;
 * - disable growth-only nudges;
 * - nudge only at a fraction of that effective input budget.
 * - retain a deterministic, reversible emergency fallback when the model
 *   ignores the late nudge or the provider confirms a real overflow.
 *
 * The result is deliberately stateless and auditable. A predictive controller
 * can be layered on later only if live evidence shows this simpler policy is
 * insufficient.
 * @module dsh-arc-context/governor
 */

import { defaultConfig, type Config } from 'acp-kernel'
import type { Session } from '@deepseek-ai/dsh-session'
import type { KernelConfigInput } from './config.ts'

/** Ordinary completion budget when no caller expressed long-output intent. */
export const DEFAULT_AUTO_OUTPUT_TOKENS = 32768

/** Auto preserves explicit conversation intent; a number remains a hard cap. */
export type MaxOutputTokensPolicy = 'auto' | number

export interface AdaptiveGovernorConfig {
  /** Enable output-reserve-aware late, batched ARC nudges. Default false. */
  readonly enabled: boolean
  /** Intent-aware completion reserve (`auto`) or a hard cap. Default `auto`. */
  readonly maxOutputTokens: MaxOutputTokensPolicy
  /** Capacity kept unused for estimation error and one in-flight step. Default 32768. */
  readonly safetyMarginTokens: number
  /** Nudge line as a fraction of effective input capacity. Default 0.75. */
  readonly nudgeAtEffectiveCapacityPct: number
  /** Emergency line as a fraction of effective input capacity. Default 0.90. */
  readonly emergencyAtEffectiveCapacityPct: number
  /** Allow model-free reversible cold-storage at emergency pressure/overflow. Default true. */
  readonly emergencyFallback: boolean
}

export interface GovernorCapacity {
  readonly contextWindow: number
  readonly outputReserve: number
  readonly safetyMargin: number
  readonly effectiveInputLimit: number
  readonly nudgeAtTokens: number
  readonly emergencyAtTokens: number
}

export const DEFAULT_ADAPTIVE_GOVERNOR: AdaptiveGovernorConfig = {
  enabled: false,
  maxOutputTokens: 'auto',
  safetyMarginTokens: 32768,
  nudgeAtEffectiveCapacityPct: 0.75,
  emergencyAtEffectiveCapacityPct: 0.90,
  emergencyFallback: true,
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-arc-context: adaptiveGovernor.${label} must be a positive integer`)
  }
  return value
}

function ratio(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`dsh-arc-context: adaptiveGovernor.${label} must be between 0 and 1`)
  }
  return value
}

/** Resolve and fail-fast validate governor configuration. */
export function resolveAdaptiveGovernor(
  input: Partial<AdaptiveGovernorConfig> = {},
): AdaptiveGovernorConfig {
  const resolved = { ...DEFAULT_ADAPTIVE_GOVERNOR, ...input }
  if (resolved.maxOutputTokens !== 'auto') {
    positiveInteger(resolved.maxOutputTokens, 'maxOutputTokens')
  }
  positiveInteger(resolved.safetyMarginTokens, 'safetyMarginTokens')
  ratio(resolved.nudgeAtEffectiveCapacityPct, 'nudgeAtEffectiveCapacityPct')
  ratio(resolved.emergencyAtEffectiveCapacityPct, 'emergencyAtEffectiveCapacityPct')
  if (resolved.emergencyAtEffectiveCapacityPct <= resolved.nudgeAtEffectiveCapacityPct) {
    throw new Error(
      'dsh-arc-context: adaptiveGovernor.emergencyAtEffectiveCapacityPct '
      + 'must be greater than nudgeAtEffectiveCapacityPct',
    )
  }
  return resolved
}

/**
 * Resolve one request's completion cap.
 *
 * Auto mode treats an omitted value as ordinary output (32K), while preserving
 * a caller's explicit long-output intent. Numeric mode is the operator's hard
 * ceiling and therefore keeps the historical min(explicit, configured) rule.
 */
export function governedMaxTokens(
  current: number | undefined,
  config: AdaptiveGovernorConfig,
): number | undefined {
  if (!config.enabled) return current
  if (current !== undefined) positiveInteger(current, 'maxOutputTokens')
  if (config.maxOutputTokens === 'auto') return current ?? DEFAULT_AUTO_OUTPUT_TOKENS
  if (current === undefined) return config.maxOutputTokens
  return Math.min(current, config.maxOutputTokens)
}

/**
 * Read the durable conversation output intent before request derivation.
 * Adapter-materialized defaults are not user intent. A Governor-injected 32K
 * value is deliberately unmarked and becomes the stable conversation value.
 */
export interface OutputIntentContext {
  readonly session: Session
  readonly options: object
}

function initialMaxTokens(options: object): number | undefined {
  if (!('maxTokens' in options)) return undefined
  return typeof options.maxTokens === 'number' ? options.maxTokens : undefined
}

export function explicitMaxTokensForAgent(agent: OutputIntentContext): number | undefined {
  const header = agent.session.requestHeader()
  if (header === undefined) return initialMaxTokens(agent.options)
  if (header.adapterDefaults?.maxTokens === true) return undefined
  return header.config.maxTokens
}

/** Resolve the reserve used by this agent's pressure geometry. */
export function governedOutputReserve(
  agent: OutputIntentContext,
  config: AdaptiveGovernorConfig,
): number {
  const resolved = governedMaxTokens(explicitMaxTokensForAgent(agent), config)
  if (resolved === undefined) {
    throw new Error('dsh-arc-context: enabled Adaptive Governor must resolve an output reserve')
  }
  return positiveInteger(resolved, 'maxOutputTokens')
}

/** Compute the provider-safe input budget the pressure controller may consume. */
export function governorCapacity(
  contextWindow: number,
  config: AdaptiveGovernorConfig,
  outputReserve = config.maxOutputTokens === 'auto'
    ? DEFAULT_AUTO_OUTPUT_TOKENS
    : config.maxOutputTokens,
): GovernorCapacity {
  positiveInteger(contextWindow, 'contextWindow')
  positiveInteger(outputReserve, 'maxOutputTokens')
  const effectiveInputLimit = contextWindow - outputReserve - config.safetyMarginTokens
  if (effectiveInputLimit <= 0) {
    throw new Error(
      'dsh-arc-context: adaptiveGovernor output reserve + safety margin '
      + `(${outputReserve + config.safetyMarginTokens}) must be below context window (${contextWindow})`,
    )
  }
  return {
    contextWindow,
    outputReserve,
    safetyMargin: config.safetyMarginTokens,
    effectiveInputLimit,
    nudgeAtTokens: Math.floor(effectiveInputLimit * config.nudgeAtEffectiveCapacityPct),
    emergencyAtTokens: Math.floor(effectiveInputLimit * config.emergencyAtEffectiveCapacityPct),
  }
}

/** Decide whether the model-free fuse may act for this host trigger. */
export function shouldRunEmergencyFallback(
  trigger: 'pressure' | 'context-overflow',
  projectedTokens: number | null,
  contextWindow: number,
  config: AdaptiveGovernorConfig,
  outputReserve?: number,
): boolean {
  if (!config.enabled || !config.emergencyFallback) return false
  if (trigger === 'context-overflow') return true
  if (projectedTokens === null || !Number.isFinite(projectedTokens)) return false
  return projectedTokens >= governorCapacity(contextWindow, config, outputReserve).emergencyAtTokens
}

/**
 * Translate the governor policy into kernel inputs.
 *
 * Growth-only nudges are disabled by setting their adaptive threshold to the
 * whole effective input budget. The kernel's over-limit and emergency paths
 * remain intact and render the ordinary ARC range table/tool guidance.
 */
export function governedKernelInput(
  input: KernelConfigInput,
  config: AdaptiveGovernorConfig,
  outputReserve?: number,
): KernelConfigInput {
  if (!config.enabled) return input
  const capacity = governorCapacity(input.modelContextLimit, config, outputReserve)
  const baseNudge = defaultConfig(capacity.effectiveInputLimit).nudge
  const inheritedNudge = input.coreOverrides?.nudge
  const disabledGrowth = capacity.effectiveInputLimit
  const nudge: Config['nudge'] = {
    ...baseNudge,
    ...inheritedNudge,
    growthRatio: 1,
    growthFloor: disabledGrowth,
    growthCap: disabledGrowth,
    minGrowthFloor: disabledGrowth,
    minGrowthRatio: 1,
  }
  return {
    ...input,
    modelContextLimit: capacity.effectiveInputLimit,
    nudgeMaxContextLimitPct: config.nudgeAtEffectiveCapacityPct,
    nudgeEmergencyThresholdPct: config.emergencyAtEffectiveCapacityPct,
    coreOverrides: { ...input.coreOverrides, nudge },
  }
}
