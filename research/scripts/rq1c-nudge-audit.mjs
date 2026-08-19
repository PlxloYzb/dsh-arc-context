#!/usr/bin/env node
/**
 * RQ1 closure (task C) — offline nudge audit over the task-C session log.
 *
 * For every durable ARC nudge (user/message with source.plugin 'arc-nudge')
 * this derives the pressure basis behind its percentage reading and applies
 * the RELEASE compression-aware correction: max(0, basis − ledger shadowed
 * tokens so far (conservative because it ignores the summary text that also
 * re-enters the surface; the real correction is larger). A post-compression
 * emergency nudge whose corrected pressure falls below the emergency tier is
 * an over-pressure artifact that the fixed reader cannot emit as emergency.
 *
 * The reading source is pinned by matching each nudge's implied basis
 * (pct × modelContextLimit) against the host contextPressure projection
 * trajectory and ARC's own arc_status estimate (both projection-sourced),
 * against the alternative chain (token meter / character heuristic).
 *
 *   RQ1C_LOG=/tmp/rq1c-s1.jsonl node research/scripts/rq1c-nudge-audit.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const research = fileURLToPath(new URL('..', import.meta.url))
const resultsPath = resolve(research, 'results', 'projection-subtraction-results.json')
const WINDOW = 32768
const FORCED = 0.70
const EMERGENCY = 0.85

const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
const sessionsRoot = process.env.RQ3_SESSIONS_ROOT
let logPath = process.env.RQ1C_LOG
if (!logPath) {
  if (!sessionsRoot) {
    console.error('set RQ1C_LOG or RQ3_SESSIONS_ROOT')
    process.exit(2)
  }
  let dir = null
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(sessionsRoot, entry.name, results.sessionId)
    try {
      if (readdirSync(candidate).includes('session.jsonl.zstd')) dir = candidate
    } catch { /* not here */ }
  }
  if (dir === null) throw new Error('session log not found')
  logPath = join(dir, 'session.jsonl.zstd')
}
const raw = logPath.endsWith('.zstd')
  ? execFileSync('zstd', ['-dc', logPath], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })
  : readFileSync(logPath, 'utf8')
const events = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

const textOf = (e) => (e.data?.content ?? []).map((b) => b?.text ?? '').join('')
const nudges = []
let shadowed = 0
const shadowTrail = []
for (const e of events) {
  if (e.type === 'compaction/summary') {
    shadowed += e.data?.shadowedTokenCount ?? 0
  }
  if (e.type === 'user/message' && e.data?.source?.plugin === 'arc-nudge') {
    const text = textOf(e)
    const match = /ARC (\d+)%/.exec(text)
    if (match) {
      nudges.push({
        seq: e.seq,
        pct: Number(match[1]),
        tier: text.includes('compress now') ? 'emergency' : 'normal',
        basisTokens: Math.round((Number(match[1]) / 100) * WINDOW),
        ledgerShadowedSoFar: shadowed,
      })
    }
  }
  shadowTrail.push({ seq: e.seq, shadowed })
}
const compactionSeq = events.find((e) => e.type === 'compaction/summary')?.seq ?? null
for (const n of nudges) {
  n.postCompression = compactionSeq !== null && n.seq > compactionSeq
  n.compressionAwareTokens = Math.max(0, n.basisTokens - n.ledgerShadowedSoFar)
  n.conservativeAwarePct = Number(((n.compressionAwareTokens / WINDOW) * 100).toFixed(1))
  n.awareTier = n.conservativeAwarePct >= EMERGENCY * 100 ? 'emergency'
    : n.conservativeAwarePct >= FORCED * 100 ? 'normal-forced'
      : 'below-forced-line (no nudge)'
  n.overpressureArtifact = n.postCompression && n.tier === 'emergency' && n.conservativeAwarePct < EMERGENCY * 100
}

const preCompression = nudges.filter((n) => !n.postCompression)
const postCompression = nudges.filter((n) => n.postCompression)
// Reading-source pin: the pre-compression nudge basis must match the host
// projection (not the real prompt, not a surface heuristic).
const sourcePins = []
for (const n of preCompression) {
  const timelineEntry = results.timeline.find((t) => Math.abs((t.projectedTokens ?? 0) - n.basisTokens) < 100)
  if (timelineEntry) sourcePins.push({ seq: n.seq, pct: n.pct, basisTokens: n.basisTokens, hostProjectedTokens: timelineEntry.projectedTokens, matchDelta: timelineEntry.projectedTokens - n.basisTokens })
}

results.postCompressionNudgeAudit = {
  derivedFrom: 'durable session log (offline zstd re-read; zero additional model calls)',
  correctionModel: 'conservative compression-aware counterfactual: nudge basis − ledger shadowedTokenCount at nudge time (ignores the summary text that also re-enters the surface, so the true correction is larger; any decision flip under the conservative correction is definitive)',
  windowMath: { modelContextLimit: WINDOW, forcedPct: FORCED * 100, emergencyPct: EMERGENCY * 100 },
  nudges,
  readingSourcePins: {
    preCompressionBasisMatchesHostProjection: sourcePins,
    arcStatusEstimate: results.arcStatusOutput?.match(/estimated context: (\d+) \/ (\d+) \((\d+)%\)/)?.slice(1).map(Number) ?? null,
    note: 'the nudge percentage basis and arc_status estimate both track the host contextPressure projection scale; neither reflects the 5,638 shadowed tokens (rule-2 chain: sessionProjections preferred)',
  },
  summary: {
    preCompressionNudges: preCompression.length,
    postCompressionNudges: postCompression.length,
    postCompressionEmergencyArtifacts: postCompression.filter((n) => n.overpressureArtifact).length,
    wouldNotFireAtAll: postCompression.filter((n) => n.conservativeAwarePct < FORCED * 100).length,
  },
  releaseCounterfactual: {
    reader: 'ARC 0.2.0-beta.6 effective projectedTokens = max(0, host projection − log-rebuilt ledger shadowedTokenCount)',
    postCompressionEmergencyNudgesWithFix: postCompression.filter((n) => n.awareTier === 'emergency').length,
    preventedEmergencyArtifacts: postCompression.filter((n) => n.tier === 'emergency' && n.awareTier !== 'emergency').length,
    postCompressionNudgesSuppressedWithFix: postCompression.filter((n) => n.awareTier === 'below-forced-line (no nudge)').length,
    postCompressionNormalNudgesWithFix: postCompression.filter((n) => n.awareTier === 'normal-forced').length,
  },
}
writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results.postCompressionNudgeAudit.summary, null, 2))
console.log(JSON.stringify(nudges, null, 2))
