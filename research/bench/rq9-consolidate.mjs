#!/usr/bin/env node
/**
 * RQ9 live settlement — fold the v3 paired arms into the RQ9 record and
 * adjudicate the shipped default.
 *
 * Protocol validity requires every scored arm to have its appendix budget
 * actually bind (the policy only exists in the truncation regime). The gate
 * for keeping `safetyIndexRanking = 'value'` as the shipped default:
 *   - paired appendix(index) loose delta (value − chronological) min >= 0
 *   - paired blind loose delta min >= -10pp
 *
 * Usage: node research/bench/rq9-consolidate.mjs
 *
 * NOTE: the FINAL 2026-08-19 settlement was adjudicated by the maintainer
 * (offline matrix primary; one clean live pair + pilot observations
 * corroborating) and written directly into rq9-type-weighting-results.json;
 * this calculator preserves the strict four-pair rule for reruns.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'

const ROOT = process.cwd()
const bench = (name) => resolve(ROOT, 'research/results/bench', name)
const ARMS = ['en-1', 'en-2', 'zh-1', 'zh-2']
const load = (variant, arm) => JSON.parse(readFileSync(bench(`rq9-live-${variant}-${arm}.json`), 'utf8'))
const rate = (score) => Number(score.split('/')[0]) / Number(score.split('/')[1])

const value = ARMS.map((arm) => ({ arm, ...load('value', arm) }))
const chrono = ARMS.map((arm) => ({ arm, ...load('chrono', arm) }))
const allValid = [...value, ...chrono].every((report) => report.verification.appendixBudgetBinds && report.verification.appendixNotStarved
  && report.verification.exactlyOneModelWrittenCompaction && report.verification.noRetrievalTools)

const paired = ARMS.map((arm, index) => {
  const v = value[index]
  const c = chrono[index]
  return {
    arm,
    summaryChars: { value: v.checkpoint.modelChars, chronological: c.checkpoint.modelChars },
    indexChars: { value: v.checkpoint.indexChars, chronological: c.checkpoint.indexChars },
    appendixLoose: { value: v.checkpoint.safetyIndex.loose, chronological: c.checkpoint.safetyIndex.loose },
    appendixDeltaPp: Math.round((rate(v.checkpoint.safetyIndex.loose) - rate(c.checkpoint.safetyIndex.loose)) * 1000) / 10,
    blindLoose: { value: v.blindRecall.loose, chronological: c.blindRecall.loose },
    blindDeltaPp: Math.round((rate(v.blindRecall.loose) - rate(c.blindRecall.loose)) * 1000) / 10,
    calls: v.rawModelCalls + c.rawModelCalls,
    routing: { value: v.modelRouting.actual, chronological: c.modelRouting.actual },
  }
})

const appendixDeltaMin = Math.min(...paired.map((pair) => pair.appendixDeltaPp))
const blindDeltaMin = Math.min(...paired.map((pair) => pair.blindDeltaPp))
const sameProvider = new Set([...value, ...chrono].map((report) => report.modelRouting.actual)).size === 1
const keepDefault = allValid && sameProvider && appendixDeltaMin >= 0 && blindDeltaMin >= -10

// Live call ledger across every RQ9 live run this program consumed (v1/v2 pilots + v3 finals).
const callLedger = { v1Pilot: 0, v2Pilot: 0, v3Final: value.reduce((n, r) => n + r.rawModelCalls, 0) + chrono.reduce((n, r) => n + r.rawModelCalls, 0) }
for (const dir of ['rq9-pilot', 'rq9-pilot2', 'rq9-pilot3']) {
  try {
    for (const file of readdirSync(bench(dir))) callLedger[dir === 'rq9-pilot' ? 'v1Pilot' : dir === 'rq9-pilot2' ? 'v2Pilot' : 'v3PilotOnBeta11'] += JSON.parse(readFileSync(bench(`${dir}/${file}`), 'utf8')).rawModelCalls ?? 0
    callLedger[dir === 'rq9-pilot' ? 'v1Pilot' : dir === 'rq9-pilot2' ? 'v2Pilot' : 'v3PilotOnBeta11'] += JSON.parse(readFileSync(bench(`${dir}/${file}`), 'utf8')).rawModelCalls ?? 0
  } catch {}
}

const live = {
  protocol: 'facts-last corpus; 1 telemetry message + 12 plant stage turns; single instructed compress (summary <= 2000 chars hint); blind audit; validity requires the appendix budget to bind',
  builds: 'both arms run 0.2.0-beta.11; variants differ only by the safetyIndexRanking config overlay',
  allArmsValid: allValid,
  sameProvider,
  paired,
  criteria: {
    appendixDeltaPpMin: appendixDeltaMin,
    blindDeltaPpMin: blindDeltaMin,
    rule: 'keep default value iff all arms bind, same provider, appendix paired delta min >= 0, blind paired delta min >= -10pp',
  },
  verdict: keepDefault
    ? "default 'value' CONFIRMED by live paired A/B"
    : "default 'value' NOT confirmed — maintainer must adjudicate (flip to chronological or rerun)",
  callLedger,
}

const resultPath = resolve(ROOT, 'research/results/rq9-type-weighting-results.json')
const record = JSON.parse(readFileSync(resultPath, 'utf8'))
record.live = live
record.decision.liveConfirmation = keepDefault ? 'live paired A/B passed 2026-08-19; default value ships' : 'live paired A/B did not confirm; see live.verdict'
writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify({ file: resultPath, allValid, sameProvider, appendixDeltaMin, blindDeltaMin, verdict: live.verdict, calls: callLedger }, null, 2))
if (!keepDefault) process.exitCode = 1
