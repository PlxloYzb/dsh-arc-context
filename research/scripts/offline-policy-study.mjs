#!/usr/bin/env node
/**
 * Zero-API policy study for an adaptive reversible context governor.
 *
 * Replays the monotonically increasing context-pressure envelope from existing
 * no-compaction runs, then simulates a controller that:
 *   1. caps the per-request output reserve;
 *   2. stays passive until a soft trigger;
 *   3. performs one batched reversible compaction to a configurable target;
 *   4. repeats only after enough new context accumulates.
 *
 * This is deliberately a policy screen, not a claim about exact LLM cost.
 * It eliminates obviously bad candidates before any paid Flash run.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BENCH = process.env.BENCH ?? process.cwd()
const RUN_IDS = ['hp-nocomp-01', 'hp2-nocomp-01', 'hp2-nocomp-02']

function eventsOf(runId) {
  const path = join(BENCH, 'runs', runId, '__evidence__', 'mux-events.jsonl')
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

function pressureEnvelope(runId) {
  const points = []
  for (const event of eventsOf(runId)) {
    if (event.method !== 'session/projection') continue
    const payload = event.payload ?? {}
    if (payload.key !== 'contextPressure') continue
    const value = payload.value ?? {}
    const pressure = value.pressureTokens
    if (!Number.isFinite(pressure) || pressure <= 0) continue
    points.push({ seq: payload.seq ?? 0, at: event.at, pressure })
  }
  points.sort((a, b) => a.seq - b.seq)

  // Repeated projection broadcasts and transient lower projections are not new
  // durable context. Retain only the cumulative pressure high-water marks.
  const envelope = []
  let high = 0
  for (const point of points) {
    if (point.pressure <= high) continue
    high = point.pressure
    envelope.push(point)
  }
  return envelope
}

function usageStats(runId) {
  const path = join(BENCH, 'runs', runId, '__evidence__', 'session-history.json')
  const history = JSON.parse(readFileSync(path, 'utf8'))
  const outputs = []
  for (const item of history.result.value.events) {
    const event = item.event
    if (event?.type !== 'assistant/chunk') continue
    const chunk = event.data?.chunk
    if (chunk?.type !== 'usage') continue
    outputs.push(chunk.usage?.outputTokens ?? 0)
  }
  outputs.sort((a, b) => a - b)
  const quantile = (p) => outputs[Math.min(outputs.length - 1, Math.floor((outputs.length - 1) * p))] ?? 0
  return {
    requests: outputs.length,
    maxOutput: outputs.at(-1) ?? 0,
    p99Output: quantile(0.99),
    p95Output: quantile(0.95),
  }
}

function simulate(envelope, policy) {
  let removed = 0
  let surface = 0
  let peak = 0
  const actions = []
  for (const point of envelope) {
    surface = Math.max(0, point.pressure - removed)
    peak = Math.max(peak, surface)
    if (surface < policy.softTrigger) continue
    const reclaimed = Math.max(0, surface - policy.postCompactTarget)
    if (reclaimed < policy.minBatch) continue
    actions.push({ seq: point.seq, before: surface, after: policy.postCompactTarget, reclaimed })
    removed += reclaimed
    surface = policy.postCompactTarget
  }
  const finalRaw = envelope.at(-1)?.pressure ?? 0
  const finalSurface = Math.max(0, finalRaw - removed)
  const overflow = peak + policy.outputReserve + policy.safetyMargin > policy.contextWindow
  return { actions, peak, finalSurface, overflow }
}

const contextWindow = 1_000_000
const reserveCandidates = [32_000, 48_000, 64_000]
const triggerRatios = [0.55, 0.65, 0.75, 0.82]
const targetCandidates = [80_000, 120_000, 180_000]
const safetyMargin = 32_000
const minBatch = 250_000

const runs = Object.fromEntries(RUN_IDS.map((runId) => [runId, {
  envelope: pressureEnvelope(runId),
  usage: usageStats(runId),
}]))

const policies = []
for (const outputReserve of reserveCandidates) {
  const effectiveLimit = contextWindow - outputReserve - safetyMargin
  for (const triggerRatio of triggerRatios) {
    for (const postCompactTarget of targetCandidates) {
      const policy = {
        contextWindow,
        outputReserve,
        safetyMargin,
        softTrigger: Math.floor(effectiveLimit * triggerRatio),
        postCompactTarget,
        minBatch,
      }
      const simulations = Object.fromEntries(Object.entries(runs).map(([runId, run]) => [runId, simulate(run.envelope, policy)]))
      // Screen objective: no action on the safe hp run, no overflow on either
      // hp2 trace, then minimize total actions and prefer later triggers.
      const hpActions = simulations['hp-nocomp-01'].actions.length
      const hp2Overflow = simulations['hp2-nocomp-01'].overflow || simulations['hp2-nocomp-02'].overflow
      const totalActions = Object.values(simulations).reduce((sum, result) => sum + result.actions.length, 0)
      const score = (hpActions * 1_000_000) + (hp2Overflow ? 100_000 : 0) + (totalActions * 1_000) - policy.softTrigger / 1_000
      policies.push({ policy, simulations, score })
    }
  }
}
policies.sort((a, b) => a.score - b.score)

const result = {
  generatedAt: new Date().toISOString(),
  source: 'existing no-compaction event traces only; no API calls',
  limitations: [
    'Compaction is modeled as a reversible batch reset to a target surface; exact model-written summary size is not simulated.',
    'The model screens trigger timing and action count, not exact uncached-input cost.',
    'Live validation remains necessary for model compliance, factual retention, and cache behavior.',
  ],
  observedOutputUsage: Object.fromEntries(Object.entries(runs).map(([runId, run]) => [runId, run.usage])),
  rawPeaks: Object.fromEntries(Object.entries(runs).map(([runId, run]) => [runId, run.envelope.at(-1)?.pressure ?? 0])),
  topPolicies: policies.slice(0, 12),
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
