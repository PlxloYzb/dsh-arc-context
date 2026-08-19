#!/usr/bin/env node
/**
 * RQ1 closure (task A) — re-score the eight RQ3 sessions with the
 * form-contract v2 scorer, offline, zero model calls.
 *
 * The RQ3 bench reports recorded per-fact strict results but not the raw
 * answer text; the sessions themselves live in the isolated DSH_HOME's
 * append-only logs (never deleted — decompress/search rebuild from them).
 * This script re-reads those logs, rebuilds the query-turn corpora exactly
 * the way rq3-recall.mjs built them, re-scores with the v2 scorer, verifies
 * the strict caliber still reproduces the recorded numbers (a corrupted
 * rebuild must fail loud, not silently shift baselines), and merges a
 * `rescored` block into results/rq3-recall-results.json without touching any
 * original field.
 *
 * Usage:
 *   RQ3_SESSIONS_ROOT=<isolated-home>/sessions node research/scripts/rescore-rq3.mjs
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildScript } from '../bench/script.mjs'
import { scoreRecall } from '../bench/scorer.mjs'

const research = fileURLToPath(new URL('..', import.meta.url))
const benchDir = join(research, 'results', 'bench')
const resultsPath = join(research, 'results', 'rq3-recall-results.json')
const sessionsRoot = process.env.RQ3_SESSIONS_ROOT
if (!sessionsRoot) {
  console.error('set RQ3_SESSIONS_ROOT to the isolated DSH_HOME sessions directory')
  process.exit(2)
}

const STAGES = 4
const NOISE_LINES = 210

/** Locate <sessionId>/session.jsonl.zstd under the sessions root (cwd-keyed subdirs). */
function findSessionLog(sessionId) {
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(sessionsRoot, entry.name, sessionId)
    try {
      const files = readdirSync(dir)
      if (files.includes('session.jsonl.zstd')) return join(dir, 'session.jsonl.zstd')
    } catch { /* not here */ }
  }
  return null
}

function readEvents(sessionId) {
  const log = findSessionLog(sessionId)
  if (log === null) throw new Error(`session log not found for ${sessionId}`)
  const raw = execFileSync('zstd', ['-dc', log], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })
  return raw.trim().split('\n').filter(Boolean).map((line) => {
    const event = JSON.parse(line)
    return event.event ?? event
  })
}

/** Query-turn corpora, exactly as rq3-recall.mjs derived them. */
function queryCorpora(events) {
  const calls = events.filter((ev) => ev.type === 'assistant/message' && (ev.data ?? {}).usage)
  const maxTurn = Math.max(0, ...calls.map((c) => (c.data ?? {}).turn ?? 0))
  const answerCorpus = []
  const toolResults = []
  for (const ev of events) {
    const d = ev.data ?? {}
    if ((d.turn ?? 0) <= maxTurn - 1) continue
    if (ev.type === 'assistant/message') {
      for (const block of d.message?.content ?? []) if (block.type === 'text') answerCorpus.push(block.text)
    }
    if (ev.type === 'tool/result') {
      let text = ''
      for (const outer of d.message?.content ?? []) for (const inner of outer.content ?? []) if (inner.type === 'text') text += inner.text + '\n'
      toolResults.push(text)
    }
  }
  return { answer: answerCorpus.join('\n'), tool: toolResults.join('\n') }
}

const byCategory = (perFact, key) => {
  const out = {}
  for (const pf of perFact) {
    out[pf.category] ??= { hit: 0, hitLoose: 0, total: 0 }
    out[pf.category].total += 1
    if (pf[key]) out[pf.category][key] += 1
  }
  return Object.fromEntries(Object.entries(out).map(([c, v]) => [c, `${v[key]}/${v.total}`]))
}

const reportFiles = readdirSync(benchDir)
  .filter((f) => /^rq3-(en|zh)-(blind|recovery)-\d.*\.json$/.test(f))
  .sort()
const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
const perArm = {}
for (const file of reportFiles) {
  const report = JSON.parse(readFileSync(join(benchDir, file), 'utf8'))
  if (report.error) continue
  const { arm, locale, seed } = report
  const script = buildScript(seed, { locale, stages: STAGES, facts: 24, noiseLines: NOISE_LINES, queryMode: 'blind' })
  const events = readEvents(report.sessionId)
  const { answer, tool } = queryCorpora(events)
  const scoring = scoreRecall(script.facts, answer + '\n' + tool, {}, { answerText: answer, toolText: tool })
  if (scoring.score !== report.result.recall) {
    throw new Error(`${arm}: strict caliber changed (${scoring.score} vs recorded ${report.result.recall}) — rebuild is corrupt`)
  }
  const forms = { full: 0, bare: 0, miss: 0 }
  for (const pf of scoring.perFact) forms[pf.form] += 1
  perArm[arm] = {
    strict: scoring.score,
    loose: scoring.scoreLoose,
    byCategoryStrict: byCategory(scoring.perFact, 'hit'),
    byCategoryLoose: byCategory(scoring.perFact, 'hitLoose'),
    forms,
    trapClassification: scoring.trapClassification,
    trapEvidence: scoring.trapClassification
      .filter((t) => t.cls !== 'clean')
      .map((t) => ({ id: t.id, cls: t.cls, snippet: snippetAround(answer, script.facts.find((f) => f.id === t.id)?.needle) })),
  }
}

function snippetAround(text, marker) {
  if (!marker) return null
  const idx = text.indexOf(marker)
  if (idx === -1) return null
  return text.slice(Math.max(0, idx - 120), idx + marker.length + 120).replace(/\s+/g, ' ').trim()
}

const pooled = {}
for (const locale of ['en', 'zh']) {
  for (const mode of ['blind', 'recovery']) {
    const arms = Object.keys(perArm).filter((a) => a.startsWith(`${locale}-${mode}-`))
    const parts = arms.map((a) => perArm[a].strict.split('/').map(Number))
    const looseParts = arms.map((a) => perArm[a].loose.split('/').map(Number))
    const strict = parts.reduce((acc, [r]) => acc + r, 0)
    const loose = looseParts.reduce((acc, [r]) => acc + r, 0)
    const total = parts.reduce((acc, [, t]) => acc + t, 0)
    pooled[`${locale}-${mode}`] = {
      strict: `${strict}/${total}`, strictRate: Number((strict / total).toFixed(4)),
      loose: `${loose}/${total}`, looseRate: Number((loose / total).toFixed(4)),
    }
  }
}

const quotedRefused = Object.entries(perArm).filter(([, v]) => v.trapClassification.some((t) => t.cls === 'quoted-refused')).map(([a]) => a)
const complied = Object.entries(perArm).filter(([, v]) => v.trapClassification.some((t) => t.cls === 'complied')).map(([a]) => a)
results.rescored = {
  rescoredAt: new Date().toISOString(),
  scorer: 'bench form-contract v2 (numeric bare value; crossref label-optional target anchor; paraphrase keyword anchors unchanged) — strict caliber verified byte-equal to the recorded RQ3 numbers before merging',
  corporaSource: 'append-only session logs of the eight RQ3 sessions in the isolated DSH_HOME (offline zstd re-read; no model calls)',
  perArm,
  pooled,
  trapOutcome: {
    quotedRefusedArms: quotedRefused,
    compliedArms: complied,
    calibrationSample: 'zh-recovery-1 must appear in quotedRefusedArms (RQ3 finding: marker quoted with explicit rejection)',
  },
}
writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ pooled, quotedRefused, complied }, null, 2))
