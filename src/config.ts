/**
 * Kernel configuration assembly — the DSH counterpart of billion-context-pi's
 * `resolveConfig`: build acp-kernel's `Config` from adapter-level knobs.
 *
 * Defaults are deliberately the acp-kernel `defaultConfig` values (the same
 * defaults billion-context-pi ships: nudge window 45%–75%, emergency 95%,
 * growth ratio 5%, protected last messages 5). Every knob is optional — an
 * omitted value keeps the kernel default, so the behavior matches the Pi
 * adapter exactly unless a deployment opts out.
 *
 * NOTE: `ArcCompactionEngine` (src/index.ts) ships its own engine-level
 * defaults 0.70/0.85 for the two nudge thresholds on top of this layer, so an
 * engine with no explicit config lands on 0.70/0.85, not 0.75/0.95.
 * @module dsh-arc-context/config
 */

import { defaultConfig, type Config } from 'acp-kernel'

/** The kernel-facing knobs shared by the nudge path and the compress tool. */
export interface KernelConfigInput {
  readonly modelContextLimit: number
  /** Nudge window lower bound (usage fraction; validation only — the growth-driven trigger has no percentage floor). Kernel default: 0.45. */
  readonly nudgeMinContextLimitPct?: number
  /** Nudge window upper bound — over-limit guarantee line. Kernel default: 0.75. */
  readonly nudgeMaxContextLimitPct?: number
  /** Emergency nudge threshold (bypasses per-turn dedup). Kernel default: 0.95. */
  readonly nudgeEmergencyThresholdPct?: number
  /** Protected-zone size: number of trailing messages never compressible. Kernel default: 5. */
  readonly protectedRecentMessages?: number
  /** Protected-zone size: trailing tokens never compressible. Kernel default: 5000. */
  readonly protectedRecentTokens?: number
  /** Minimum total original chars for a compressible range. Kernel default: 5000. */
  readonly minCompressChars?: number
  /** Nudge cadence: minimum turns between normal nudges. Kernel default: 5. */
  readonly nudgeCadenceTurns?: number
  /** Any other acp-kernel Config override (the billion-context-pi escape hatch). */
  readonly coreOverrides?: Partial<Config>
}

/**
 * Assemble the kernel config: `defaultConfig(limit)` merged with the optional
 * nudge thresholds (merged into the defaults, never replacing them wholesale)
 * and any additional `coreOverrides`.
 */
export function kernelConfigFor(input: KernelConfigInput): Config {
  const nudgePatch: Partial<Config['nudge']> = {}
  if (input.nudgeMinContextLimitPct !== undefined) nudgePatch.minContextLimitPct = input.nudgeMinContextLimitPct
  if (input.nudgeMaxContextLimitPct !== undefined) nudgePatch.maxContextLimitPct = input.nudgeMaxContextLimitPct
  if (input.nudgeEmergencyThresholdPct !== undefined) nudgePatch.emergencyThresholdPct = input.nudgeEmergencyThresholdPct

  const overrides: Partial<Config> = { ...input.coreOverrides }
  if (input.protectedRecentMessages !== undefined) {
    overrides.preserveRecentMessages = input.protectedRecentMessages
  }
  if (input.protectedRecentTokens !== undefined) {
    overrides.preserveRecentTokens = input.protectedRecentTokens
  }
  if (input.minCompressChars !== undefined) {
    overrides.compress = { ...defaultConfig(input.modelContextLimit).compress, ...input.coreOverrides?.compress }
    overrides.compress.minCompressRange = input.minCompressChars
  }
  if (input.nudgeCadenceTurns !== undefined) {
    nudgePatch.frequency = input.nudgeCadenceTurns
  }
  if (Object.keys(nudgePatch).length > 0) {
    // Preserve advanced `coreOverrides.nudge` fields (growth policy, cadence,
    // etc.) while letting the adapter-level threshold knobs win. Previously
    // any top-level threshold silently replaced the whole nested nudge object,
    // which made Adaptive Governor's growth suppression ineffective.
    overrides.nudge = {
      ...defaultConfig(input.modelContextLimit).nudge,
      ...input.coreOverrides?.nudge,
      ...nudgePatch,
    }
  }
  return defaultConfig(input.modelContextLimit, overrides)
}
