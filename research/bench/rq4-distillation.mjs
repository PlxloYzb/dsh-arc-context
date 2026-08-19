#!/usr/bin/env node
/**
 * RQ4 — forced tier-1 -> tier-2 -> tier-3 distillation measurement.
 *
 * This is deliberately an instruction-driven experiment: every checkpoint is
 * written by the selected model through `compress`; no summary text is supplied
 * by the driver.  Tier 2 and tier 3 each target the live checkpoint node made
 * by their parent operation, rather than re-compressing the original source.
 *
 * Usage:
 *   node research/bench/rq4-distillation.mjs offline
 *   RQ4_URL=http://127.0.0.1:8933 node research/bench/rq4-distillation.mjs live
 *   node research/bench/rq4-distillation.mjs consolidate <matrix.json>
 *   node research/bench/rq4-distillation.mjs resume <sessionId> <en-2>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildScript } from './script.mjs'
import { makeClient } from './driver.mjs'
import { buildLedger } from './ledger.mjs'
import { scoreRecall } from './scorer.mjs'

const URL = process.env.RQ4_URL ?? 'http://127.0.0.1:8933'
const CWD = process.env.RQ4_CWD ?? process.cwd()
const OUT = resolve(process.env.RQ4_OUT ?? 'research/results/bench')
const FINAL = resolve(process.env.RQ4_FINAL ?? 'research/results/rq4-distillation-results.json')
const BUDGET = Number(process.env.RQ4_BUDGET ?? 40)
const ARMS = (process.env.RQ4_ARMS ?? 'en-1,en-2,zh-1').split(',')
const PREFERRED = { provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
const FALLBACK = { provider: 'scnet', model: 'GLM-5.2', reasoningEffort: 'max' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const summaryText = (v) => Array.isArray(v)
  ? v.filter((b) => b?.type === 'text').map((b) => b.text).join('') : String(v ?? '')
const extractText = (value) => {
  if (Array.isArray(value)) return value.map(extractText).join('')
  if (!value || typeof value !== 'object') return ''
  if (value.type === 'text') return String(value.text ?? '')
  return extractText(value.content ?? '')
}
const INDEX_MARKER = '[ARC MODEL-CHECKPOINT SAFETY INDEX — REVERSIBLE EXTRACTIVE APPENDIX]'

function splitCheckpoint(text) {
  const at = text.indexOf(INDEX_MARKER)
  return at < 0 ? { model: text, index: '' } : { model: text.slice(0, at), index: text.slice(at) }
}

function rangesForUserTurns(events) {
  const users = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
  return users.map((e, i) => ({ startSeq: e.seq, endSeq: i + 1 < users.length ? users[i + 1].seq - 1 : 999999 }))
}

function compressPrompt(range, tier) {
  return `This is a context-management measurement. Call compress exactly once with content:\n[{ startSeq: ${range.startSeq}, endSeq: ${range.endSeq}, summary: <write your own faithful tier-${tier} summary> }]\nDo not copy this placeholder. Write the checkpoint yourself under your normal compression rules, then reply exactly: TIER-${tier}-COMPRESSED.`
}

async function waitIdle(client, sessionId) {
  let saw = false
  for (let i = 0; i < 300; i += 1) {
    await sleep(1500)
    const sessions = await client.call('session.list', {})
    const row = sessions.items.find((item) => item.sessionId === sessionId)
    if (row?.running) saw = true
    else if (saw || i > 7) return
  }
  throw new Error('session did not settle within polling bound')
}

async function prompt(client, sessionId, text) {
  await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  await waitIdle(client, sessionId)
}

async function history(client, sessionId) {
  const h = await client.call('session.history', { sessionId, maxMessages: 100000 })
  return h.events.map((entry) => entry.event ?? entry)
}

function compactions(events) {
  const out = []
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue
    const text = summaryText(event.data?.summary)
    const next = events.find((candidate) => candidate.seq === event.seq + 1 && candidate.type === 'user/message')
    out.push({
      eventSeq: event.seq, checkpointSeq: next?.seq ?? null,
      compactionId: event.data?.compactionId, blockId: event.data?.compactionId,
      tier: event.data?.tier ?? null, shadowedRange: event.data?.shadowedRange ?? null,
      shadowedTokenCount: event.data?.shadowedTokenCount ?? null, text,
      effectiveMessageIds: event.data?.effectiveMessageIds ?? null,
      ...splitCheckpoint(text),
    })
  }
  return out
}

function callsFrom(events) {
  return events.filter((e) => e.type === 'assistant/message' && e.data?.usage).map((e) => ({
    seq: e.seq, turn: e.data.turn, step: e.data.step, prevSeq: Math.max(0, e.seq - 1),
    usage: {
      uncachedInputTokens: e.data.usage.uncachedInputTokens ?? e.data.usage.inputTokens ?? 0,
      cacheReadTokens: e.data.usage.cacheReadTokens ?? 0,
      outputTokens: e.data.usage.outputTokens ?? 0,
    },
  }))
}

// A tier-N decompressor restores the messages that the tier-1 block hid; it
// does not reproduce the model-authored tier-1 *summary*.  Check the durable
// effective source coverage instead of depending on a summary's optional,
// model-written "Source:" prose.
function recoverableEffectiveSource(events, tier1) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const ids = tier1.effectiveMessageIds ?? (tier1.shadowedRange === null
    ? []
    : Array.from({ length: tier1.shadowedRange.end - tier1.shadowedRange.start + 1 }, (_, i) => String(tier1.shadowedRange.start + i)))
  return ids.map(Number).flatMap((seq) => {
    const event = bySeq.get(seq)
    const text = event === undefined ? '' : extractText(event.data?.message?.content ?? event.data?.content)
    return text.length === 0 ? [] : [{ seq, text }]
  })
}

function reassessDecompression(events, tier1, tier2, toolText) {
  const source = recoverableEffectiveSource(events, tier1)
  const missing = source.filter(({ seq, text }) => !toolText.includes(`[seq ${seq}] ${text}`)).map(({ seq }) => seq)
  return {
    criterion: 'all effective tier-1 source events with renderable text occur verbatim in tier-2 decompression output',
    effectiveSourceSeqs: source.map(({ seq }) => seq),
    missingEffectiveSourceSeqs: missing,
    result: missing.length === 0 ? 'pass-full-effective-source' : 'fail-or-truncated',
  }
}

function tierMetrics(facts, checkpoints) {
  return checkpoints.map((checkpoint, index) => {
    const model = scoreRecall(facts, checkpoint.model)
    const safetyIndex = scoreRecall(facts, checkpoint.index)
    const both = []
    const modelOnly = []
    const indexOnly = []
    const lost = []
    for (const fact of facts.filter((f) => f.category !== 'trap')) {
      const m = model.perFact.find((x) => x.id === fact.id)
      const s = safetyIndex.perFact.find((x) => x.id === fact.id)
      const mh = Boolean(m?.hitLoose)
      const sh = Boolean(s?.hitLoose)
      if (mh && sh) both.push(fact.id)
      else if (mh) modelOnly.push(fact.id)
      else if (sh) indexOnly.push(fact.id)
      else lost.push(fact.id)
    }
    const survivors = both.length + modelOnly.length + indexOnly.length
    return {
      tier: index + 1, blockId: checkpoint.blockId, checkpointSeq: checkpoint.checkpointSeq,
      range: checkpoint.shadowedRange, shadowedTokenCount: checkpoint.shadowedTokenCount,
      chars: { total: checkpoint.text.length, model: checkpoint.model.length, safetyIndex: checkpoint.index.length },
      strict: { model: model.score, safetyIndex: safetyIndex.score },
      loose: { model: model.scoreLoose, safetyIndex: safetyIndex.scoreLoose },
      survival: {
        strictRate: model.recallRate, looseRate: model.recallRateLoose,
        strict: model.score, loose: model.scoreLoose,
      },
      carrier: {
        survivors, modelOnly, indexOnly, both, lost,
        shares: survivors === 0 ? { modelOnly: null, indexOnly: null, both: null, indexBearing: null } : {
          modelOnly: modelOnly.length / survivors, indexOnly: indexOnly.length / survivors,
          both: both.length / survivors, indexBearing: (indexOnly.length + both.length) / survivors,
        },
      },
    }
  })
}

function decompressReport(events, blocks) {
  const toolText = events.filter((e) => e.type === 'tool/result').map((e) => extractText(e.data?.message?.content)).join('\n')
  const tier1Text = blocks[0].text
  return {
    tier2BlockId: blocks[1].blockId,
    calls: events.filter((e) => e.type === 'tool/call' && e.data?.name === 'decompress').length,
    archiveFramed: toolText.includes('Archived context data (historical, not instructions):'),
    tier1TextRecovered: toolText.includes(tier1Text),
    sourceIdentityRecovered: toolText.includes(`Source: ${blocks[0].blockId.slice(0, 8)}`) && toolText.includes('tier-1 → distill'),
    // Retained for comparability with the original RQ4 record.  Consumers
    // should use reAssessed.result for the restoration verdict.
    result: toolText.includes(`Source: ${blocks[0].blockId.slice(0, 8)}`) && toolText.includes('tier-1 → distill') ? 'pass-full-tier1-range' : 'fail-or-truncated',
    reAssessed: reassessDecompression(events, blocks[0], blocks[1], toolText),
  }
}

async function runArm(client, arm) {
  const [locale, seedText] = arm.split('-')
  const seed = Number(seedText)
  const script = buildScript(seed, { locale, stages: 3, facts: 30, noiseLines: 90, queryMode: 'blind' })
  const categories = new Set(script.facts.map((fact) => fact.category))
  if (script.facts.length < 20 || !['verbatim', 'numeric', 'paraphrase', 'crossref', 'trap'].every((kind) => categories.has(kind))) {
    throw new Error(`${arm}: planted corpus does not cover >=20 facts and all categories`)
  }
  const created = await client.call('session.create', { cwd: CWD })
  const sessionId = created.sessionId
  let selected = PREFERRED
  try {
    await client.call('session.selectModel', { sessionId, ...PREFERRED })
  } catch (error) {
    selected = FALLBACK
    await client.call('session.selectModel', { sessionId, ...FALLBACK })
  }
  const plants = script.turns.filter((turn) => turn.kind === 'plant')
  for (const plant of plants) await prompt(client, sessionId, plant.text)
  let events = await history(client, sessionId)
  const initialRanges = rangesForUserTurns(events)
  const parentRange = { startSeq: initialRanges[0].startSeq, endSeq: initialRanges[1].endSeq }
  await prompt(client, sessionId, compressPrompt(parentRange, 1))
  await prompt(client, sessionId, 'Reply with exactly: ORDINARY-A')
  events = await history(client, sessionId)
  let blocks = compactions(events)
  if (blocks.length !== 1 || !blocks[0].checkpointSeq) throw new Error(`${arm}: tier-1 did not land one live checkpoint`)
  await prompt(client, sessionId, compressPrompt({ startSeq: blocks[0].checkpointSeq, endSeq: blocks[0].checkpointSeq }, 2))
  await prompt(client, sessionId, 'Reply with exactly: ORDINARY-B')
  events = await history(client, sessionId)
  blocks = compactions(events)
  if (blocks.length !== 2 || !blocks[1].checkpointSeq) throw new Error(`${arm}: tier-2 did not land one live checkpoint`)
  await prompt(client, sessionId, compressPrompt({ startSeq: blocks[1].checkpointSeq, endSeq: blocks[1].checkpointSeq }, 3))
  events = await history(client, sessionId)
  blocks = compactions(events)
  if (blocks.length !== 3) throw new Error(`${arm}: tier-3 did not land exactly once`)

  // Engine semantic probe: model calls the public decompressor on the tier-2
  // block.  We compare its framed payload against tier-1's complete checkpoint
  // text, not merely against a fact subset.
  await prompt(client, sessionId, `Call decompress with blockId "${blocks[1].blockId}". Do not summarize its output; after the tool result, reply exactly: DECOMPRESS-CHECKED.`)
  events = await history(client, sessionId)
  const decompress = decompressReport(events, blocks)
  const targetFactIds = new Set(plants.slice(0, 2).flatMap((turn) => turn.factIds))
  const scoredFacts = script.facts.filter((fact) => targetFactIds.has(fact.id))
  const metrics = tierMetrics(scoredFacts, blocks)
  const calls = callsFrom(events)
  const ledger = buildLedger(calls, events.filter((e) => e.type === 'compaction/end').map((e) => ({ afterSeq: e.seq })))
  return {
    arm, locale, seed, sessionId, agentPreset: created.agentPreset,
    model: { requested: PREFERRED, selected, fallbackUsed: selected.provider !== PREFERRED.provider },
    design: { plantedFacts: script.facts.length, scoredFacts: scoredFacts.length, categories: [...categories].sort(), tier1Source: parentRange, ordinaryRounds: 2 },
    tiers: metrics, decompress, calls: calls.length, ledger: ledger.totals,
  }
}

function aggregate(reports, budget, stopped = null) {
  const complete = reports.filter((r) => !r.error)
  const tiers = [1, 2, 3].map((tier) => {
    const rows = complete.map((report) => report.tiers[tier - 1])
    const total = rows.reduce((n, row) => n + Number(row.survival.loose.split('/')[1]), 0)
    const strict = rows.reduce((n, row) => n + Number(row.survival.strict.split('/')[0]), 0)
    const loose = rows.reduce((n, row) => n + Number(row.survival.loose.split('/')[0]), 0)
    const carrier = ['modelOnly', 'indexOnly', 'both'].reduce((out, key) => {
      out[key] = rows.reduce((n, row) => n + row.carrier[key].length, 0); return out
    }, {})
    const survivors = carrier.modelOnly + carrier.indexOnly + carrier.both
    return { tier, strict: `${strict}/${total}`, loose: `${loose}/${total}`, strictRate: total ? strict / total : null,
      looseRate: total ? loose / total : null, carrier: { ...carrier, survivors,
        shares: survivors ? { modelOnly: carrier.modelOnly / survivors, indexOnly: carrier.indexOnly / survivors, both: carrier.both / survivors,
          indexBearing: (carrier.indexOnly + carrier.both) / survivors } : null } }
  })
  const monotonic = tiers.every((row, i) => i === 0 || row.looseRate <= tiers[i - 1].looseRate)
  const indexMajority = tiers.every((row) => (row.carrier.shares?.indexBearing ?? 0) >= 0.5)
  const tier3AtTier1 = tiers[2].looseRate >= tiers[0].looseRate
  const branch = tier3AtTier1 ? 'close-mechanism-intact' : !indexMajority ? 'index-first-doubtful' : monotonic ? 'confirmed-index-first-candidate' : 'mixed-inconclusive'
  const calls = complete.reduce((n, r) => n + r.calls, 0)
  return { schemaVersion: 1, rq: 'RQ4', generatedAt: new Date().toISOString(),
    completion: { requestedChains: ARMS.length, completeChains: complete.length, partial: complete.length !== ARMS.length, stopped },
    costLedger: { cap: budget, used: calls, withinCap: calls <= budget },
    methodology: { modelWrittenSummaries: true, tierTargets: 'live parent checkpoint nodes', sourceFractionTier1: 'first 2 of 3 planted turns', modelPreference: PREFERRED, fallback: FALLBACK },
    chains: reports, curves: { tiers, blockSize: complete.map((r) => ({ arm: r.arm, points: r.tiers.map((t) => ({ tier: t.tier, chars: t.chars.total, modelChars: t.chars.model, safetyIndexChars: t.chars.safetyIndex })) })) },
    decompression: { perChain: complete.map((r) => ({ arm: r.arm, ...r.decompress })), allTier2RecoverTier1: complete.length > 0 && complete.every((r) => r.decompress.result === 'pass-full-tier1-range') },
    criterionComparison: { tier3AtTier1, monotonicLoose: monotonic, indexMajority, branch,
      verdict: branch === 'confirmed-index-first-candidate' ? 'hypothesis-c-supported; index-first distillation is a product-candidate only, not implemented' : branch },
  }
}

function offline() {
  const checks = {}
  for (const arm of ARMS) {
    const [locale, seed] = arm.split('-')
    const script = buildScript(Number(seed), { locale, stages: 3, facts: 30, noiseLines: 90 })
    const categories = new Set(script.facts.map((f) => f.category))
    checks[arm] = script.facts.length >= 20 && ['verbatim', 'numeric', 'paraphrase', 'crossref', 'trap'].every((kind) => categories.has(kind))
  }
  const result = { mode: 'offline', checks, pass: Object.values(checks).every(Boolean) }
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.pass ? 0 : 1
}

async function live() {
  const client = makeClient(URL); const reports = []; let used = 0; let stopped = null
  for (const arm of ARMS) {
    if (used + 12 > BUDGET) { stopped = { reason: 'budget-guard', used, armNotStarted: arm }; break }
    try { const report = await runArm(client, arm); used += report.calls; reports.push(report); console.log(`${arm}: ${report.calls} calls`) }
    catch (error) { reports.push({ arm, error: String(error.message ?? error) }); console.error(`${arm}: ${error.message}`) }
  }
  mkdirSync(OUT, { recursive: true })
  const matrix = resolve(OUT, `rq4-distillation-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const result = aggregate(reports, BUDGET, stopped); writeFileSync(matrix, JSON.stringify(result, null, 2) + '\n'); writeFileSync(FINAL, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ matrix, final: FINAL, used: result.costLedger.used, branch: result.criterionComparison.branch }, null, 2))
}

// Zero-model-call recovery path for an interrupted driver: persistent session
// logs are the primary evidence source, so a completed chain can be measured
// later without re-running the conversation.  `RQ4_HISTORY` is a comma list of
// `sessionId@locale-seed` entries.
async function fromHistory() {
  const client = makeClient(URL)
  const entries = (process.env.RQ4_HISTORY ?? '').split(',').filter(Boolean)
  if (entries.length === 0) throw new Error('RQ4_HISTORY is required')
  const reports = []
  for (const entry of entries) {
    const [sessionId, arm] = entry.split('@'); const [locale, seedText] = arm.split('-'); const seed = Number(seedText)
    const script = buildScript(seed, { locale, stages: 3, facts: 30, noiseLines: 90, queryMode: 'blind' })
    const h = await client.call('session.history', { sessionId, maxMessages: 100000 })
    const events = h.events.map((e) => e.event ?? e); const blocks = compactions(events)
    if (blocks.length !== 3) throw new Error(`${sessionId}: expected 3 compactions, got ${blocks.length}`)
    const users = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
    const targetFactIds = new Set(script.turns.filter((turn) => turn.kind === 'plant').slice(0, 2).flatMap((turn) => turn.factIds))
    const scoredFacts = script.facts.filter((fact) => targetFactIds.has(fact.id))
    const toolText = events.filter((e) => e.type === 'tool/result').map((e) => extractText(e.data?.message?.content)).join('\n')
    const tier1Text = blocks[0].text; const metrics = tierMetrics(scoredFacts, blocks); const calls = callsFrom(events)
    const ledger = buildLedger(calls, events.filter((e) => e.type === 'compaction/end').map((e) => ({ afterSeq: e.seq })))
    reports.push({ arm: `${arm}-${sessionId.slice(-6)}`, locale, seed, sessionId,
      model: { requested: PREFERRED, selected: 'recorded-history (see durable event usage)', fallbackUsed: null },
      design: { plantedFacts: script.facts.length, scoredFacts: scoredFacts.length, categories: [...new Set(script.facts.map((f) => f.category))].sort(), tier1Source: blocks[0].shadowedRange, ordinaryRounds: 2 },
      tiers: metrics, decompress: { tier2BlockId: blocks[1].blockId, calls: events.filter((e) => e.type === 'tool/call' && e.data?.name === 'decompress').length,
      archiveFramed: toolText.includes('Archived context data (historical, not instructions):'), tier1TextRecovered: toolText.includes(tier1Text),
        sourceIdentityRecovered: toolText.includes(`Source: ${blocks[0].blockId.slice(0, 8)}`) && toolText.includes('tier-1 → distill'),
        result: toolText.includes(`Source: ${blocks[0].blockId.slice(0, 8)}`) && toolText.includes('tier-1 → distill') ? 'pass-full-tier1-range' : 'fail-or-truncated',
        reAssessed: reassessDecompression(events, blocks[0], blocks[1], toolText) },
      calls: calls.length, ledger: ledger.totals })
  }
  const result = aggregate(reports, BUDGET, { reason: 'driver-interrupted; measured completed durable histories zero-call' })
  mkdirSync(OUT, { recursive: true }); writeFileSync(FINAL, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ final: FINAL, calls: result.costLedger, chains: reports.length }, null, 2))
}

// Continue an interrupted chain inside its existing session: send only the
// protocol steps the durable log shows are missing (tier-2/tier-3 compress,
// ordinary filler, decompression probe), then measure exactly like a live arm.
// The whole chain keeps one session id, so resume evidence stays continuous.
//   node research/bench/rq4-distillation.mjs resume <sessionId> <en-2>
async function resumeChain() {
  const [sessionId, arm] = process.argv.slice(3)
  if (!sessionId || !/^(en|zh)-\d+$/.test(arm ?? '')) throw new Error('usage: rq4-distillation.mjs resume <sessionId> <en-1|zh-2|...>')
  const [locale, seedText] = arm.split('-'); const seed = Number(seedText)
  const script = buildScript(seed, { locale, stages: 3, facts: 30, noiseLines: 90, queryMode: 'blind' })
  const client = makeClient(URL)
  const added = []
  const pull = async () => history(client, sessionId)
  let events = await pull()
  let blocks = compactions(events)
  if (blocks.length === 1 && blocks[0].checkpointSeq) {
    await prompt(client, sessionId, compressPrompt({ startSeq: blocks[0].checkpointSeq, endSeq: blocks[0].checkpointSeq }, 2))
    await prompt(client, sessionId, 'Reply with exactly: ORDINARY-B')
    added.push('tier2', 'ordinary-b')
    events = await pull(); blocks = compactions(events)
  }
  if (blocks.length === 2 && blocks[1].checkpointSeq) {
    await prompt(client, sessionId, compressPrompt({ startSeq: blocks[1].checkpointSeq, endSeq: blocks[1].checkpointSeq }, 3))
    added.push('tier3')
    events = await pull(); blocks = compactions(events)
  }
  if (blocks.length !== 3) throw new Error(`${sessionId}: expected 3 landed checkpoints after resume, got ${blocks.length}`)
  if (!events.some((e) => e.type === 'tool/call' && e.data?.name === 'decompress')) {
    await prompt(client, sessionId, `Call decompress with blockId "${blocks[1].blockId}". Do not summarize its output; after the tool result, reply exactly: DECOMPRESS-CHECKED.`)
    added.push('decompress-probe')
    events = await pull(); blocks = compactions(events)
  }
  const context = events.find((e) => e.type === 'request/context')?.data
  const plants = script.turns.filter((turn) => turn.kind === 'plant')
  const targetFactIds = new Set(plants.slice(0, 2).flatMap((turn) => turn.factIds))
  const scoredFacts = script.facts.filter((fact) => targetFactIds.has(fact.id))
  const metrics = tierMetrics(scoredFacts, blocks)
  const calls = callsFrom(events)
  const ledger = buildLedger(calls, events.filter((e) => e.type === 'compaction/end').map((e) => ({ afterSeq: e.seq })))
  const report = {
    arm, locale, seed, sessionId, agentPreset: 'standard',
    resumed: { addedSteps: added, note: added.length === 0 ? 'measured only; nothing was missing' : 'steps above were appended to the existing session by the resume path' },
    model: { requested: PREFERRED, selected: context ? `${context.provider}/${context.model}` : 'unknown', fallbackUsed: null },
    design: { plantedFacts: script.facts.length, scoredFacts: scoredFacts.length, categories: [...new Set(script.facts.map((f) => f.category))].sort(), tier1Source: blocks[0].shadowedRange, ordinaryRounds: 2 },
    tiers: metrics, decompress: decompressReport(events, blocks), calls: calls.length, ledger: ledger.totals,
  }
  mkdirSync(OUT, { recursive: true })
  const file = resolve(OUT, `rq4-impl-treatment-${arm}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ file, arm, sessionId, calls: report.calls, addedSteps: added, tiers: metrics.map((t) => t.survival.loose) }, null, 2))
}

if (process.argv[2] === 'offline') offline()
else if (process.argv[2] === 'consolidate') { const value = JSON.parse(readFileSync(process.argv[3], 'utf8')); writeFileSync(FINAL, JSON.stringify(value, null, 2) + '\n') }
else if (process.argv[2] === 'from-history') await fromHistory()
else if (process.argv[2] === 'resume') await resumeChain()
else await live()
