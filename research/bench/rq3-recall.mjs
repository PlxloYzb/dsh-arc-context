#!/usr/bin/env node
/**
 * RQ3 + RQ8 — retrieval recall after heavy compression (en/zh mirror).
 *
 * Per session (one arm = locale × queryMode × seed):
 *   1. plant 4 staged fact turns (~24K projected tokens; facts ride in user
 *      messages, code-vocabulary needles stay Latin in both locales);
 *   2. ONE instructed compress call covering the FIRST THREE plant turns as
 *      three ranges — summaries are model-written (the instruction is neutral
 *      and provides no summary text; RQ2 lesson);
 *   3. two settle turns, then one query turn (blind: no tools; recovery:
 *      search_context/decompress allowed);
 *   4. score per-category recall (bench contract: answer corpus + tool
 *      corpus), bucket facts by shadowed (planted in turns 1-3) vs live
 *      (turn 4), count recovery tool calls and first-tool-hit ordinals.
 *
 * Compression evidence comes from the durable log (compaction/summary events:
 * shadowedRange + shadowedTokenCount) and the contextPressure projection
 * before/after — no extra model calls are spent on arc_status.
 *
 * Budget guard: model calls (assistant messages with usage) are counted
 * across sessions; past RQ3_BUDGET the remaining arms are skipped and the
 * partial matrix is reported with the reason.
 *
 *   node research/bench/rq3-recall.mjs offline
 *   RQ3_ARMS=en-blind-1,zh-recovery-2 node research/bench/rq3-recall.mjs live
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildScript } from './script.mjs'
import { makeClient } from './driver.mjs'
import { buildLedger } from './ledger.mjs'
import { scoreRecall } from './scorer.mjs'

const URL = process.env.RQ3_URL ?? 'http://127.0.0.1:8933'
const CWD = process.env.RQ3_CWD ?? process.cwd()
const OUT_DIR = resolve(process.env.RQ3_OUT ?? 'research/results/bench')
const BUDGET = Number(process.env.RQ3_BUDGET ?? 100)
const DEFAULT_ARMS = 'en-blind-1,en-blind-2,en-recovery-1,en-recovery-2,zh-blind-1,zh-blind-2,zh-recovery-1,zh-recovery-2'

// Experiment shape: 4 plant turns, compress turns 1-3 (3 ranges, one batch
// call) -> ~60-75% of the plant corpus shadowed, turn-4 facts stay live.
const STAGES = 4
const NOISE_LINES = Number(process.env.RQ3_NOISE ?? 210)
const COMPRESS_TURNS = 3
const SETTLE_TURNS = 2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- offline self-test (no API) ------------------------------------------

const cjkAwareTokens = (text) => {
  let cjk = 0
  let other = 0
  for (const ch of String(text)) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

function offline() {
  const report = { mode: 'offline', noiseLines: NOISE_LINES, stages: STAGES, checks: {}, estimates: {} }
  for (const locale of ['en', 'zh']) {
    for (const seed of [1, 2]) {
      const a = buildScript(seed, { locale, stages: STAGES, facts: 24, noiseLines: NOISE_LINES, queryMode: 'blind' })
      const b = buildScript(seed, { locale, stages: STAGES, facts: 24, noiseLines: NOISE_LINES, queryMode: 'blind' })
      report.checks[`deterministic-${locale}-${seed}`] = JSON.stringify(a) === JSON.stringify(b)
      if (seed === 1) {
        const en = buildScript(seed, { locale: 'en', stages: STAGES, facts: 24, noiseLines: NOISE_LINES, queryMode: 'blind' })
        report.checks[`${locale}-mirrors-en-structure`] =
          a.facts.map((f) => `${f.id}:${f.category}:${f.needle}`).join() === en.facts.map((f) => `${f.id}:${f.category}:${f.needle}`).join()
        const perfectLine = (f) => (f.category === 'paraphrase' ? f.statement : f.category === 'crossref' ? f.refs.join(' ') : f.needle)
        const corpus = a.facts.filter((f) => f.category !== 'trap').map(perfectLine).join('\n')
        const perfect = scoreRecall(a.facts, corpus)
        report.checks[`${locale}-perfectCorpusFull`] = perfect.recalled === perfect.scorable
        const trapIn = scoreRecall(a.facts, corpus + '\nINJ-shouldleak')
        report.checks[`${locale}-trapLeakDetected`] = trapIn.trapLeaks.length > 0 || scoreRecall(a.facts, corpus).trapLeaks.length === 0
        const plants = a.turns.filter((t) => t.kind === 'plant')
        const perTurn = plants.map((t) => cjkAwareTokens(t.text))
        report.estimates[locale] = {
          perPlantTurnTokens: perTurn,
          plantTotalTokens: perTurn.reduce((x, y) => x + y, 0),
          shadowedIfFirstThreeCompressed: perTurn.slice(0, COMPRESS_TURNS).reduce((x, y) => x + y, 0),
          shadowedFractionOfPlants: perTurn.slice(0, COMPRESS_TURNS).reduce((x, y) => x + y, 0) / perTurn.reduce((x, y) => x + y, 0),
        }
      }
    }
  }
  report.pass = Object.values(report.checks).every((v) => v === true)
  report.pass = report.pass && report.estimates.en.plantTotalTokens >= 16000 && report.estimates.en.plantTotalTokens <= 22000
  report.pass = report.pass && report.estimates.en.shadowedFractionOfPlants >= 0.6 && report.estimates.zh.shadowedFractionOfPlants >= 0.6
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.pass ? 0 : 1
}

// ---- live driver -----------------------------------------------------------

async function waitIdle(client, sessionId) {
  let saw = false
  for (let p = 0; p < 300; p += 1) {
    await sleep(2000)
    const list = await client.call('session.list', {})
    const me = list.items.find((i) => i.sessionId === sessionId)
    if (me?.running === true) saw = true
    else if (saw || p > 6) break
  }
}

async function prompt(client, sessionId, text) {
  await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  await waitIdle(client, sessionId)
}

async function pressure(client, sessionId) {
  const h = await client.call('session.history', { sessionId, maxMessages: 1 })
  return h.projections?.values?.contextPressure ?? {}
}

/** Surface turn ranges: [firstUserSeq, seqBeforeNextUserMessage]. */
function turnRanges(events) {
  const userMsgs = events.map((e) => e.event ?? e).filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
  return userMsgs.map((e, i) => ({ turn: i + 1, startSeq: e.seq, endSeq: i + 1 < userMsgs.length ? userMsgs[i + 1].seq - 1 : 999999 }))
}

function compressInstruction(ranges) {
  const list = ranges.map((r) => `{ startSeq: ${r.startSeq}, endSeq: ${r.endSeq}, summary: <write your own faithful summary> }`).join(', ')
  return `This is a context-management experiment. Call compress with content:\n[${list}]\n(follow your standard compression summary rules). Then reply COMPRESSED.`
}

function factMatches(fact, text) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const corpus = norm(text)
  if (fact.category === 'paraphrase') return (fact.keywords ?? []).every((k) => corpus.includes(norm(k)))
  const needles = fact.category === 'crossref' ? fact.refs : [fact.needle]
  return needles.every((n) => corpus.includes(norm(n)))
}

async function runArm(client, arm, usedBudget) {
  const [locale, queryMode, seedStr] = arm.split('-')
  const seed = Number(seedStr)
  const script = buildScript(seed, { locale, stages: STAGES, facts: 24, noiseLines: NOISE_LINES, queryMode })
  const plants = script.turns.filter((t) => t.kind === 'plant')
  const queryTurn = script.turns[script.turns.length - 1]

  const created = await client.call('session.create', { cwd: CWD })
  const sessionId = created.sessionId
  const plantPressure = []
  for (const turn of plants) {
    await prompt(client, sessionId, turn.text)
    const p = await pressure(client, sessionId)
    plantPressure.push({ stage: turn.stage, projectedTokens: p.projectedTokens ?? null, contextWindow: p.contextWindow ?? null })
  }

  const h1 = await client.call('session.history', { sessionId, maxMessages: 100000 })
  const ranges = turnRanges(h1.events)
  const prePressure = (await pressure(client, sessionId)).projectedTokens ?? null
  const targetRanges = ranges.slice(0, COMPRESS_TURNS).map((r) => ({ startSeq: r.startSeq, endSeq: r.endSeq }))

  await prompt(client, sessionId, compressInstruction(targetRanges))
  let h2 = await client.call('session.history', { sessionId, maxMessages: 100000 })
  let landed = h2.events.map((e) => e.event ?? e).filter((e) => e.type === 'compaction/end').length
  let compressRetried = false
  if (landed === 0) {
    compressRetried = true
    await prompt(client, sessionId, compressInstruction(targetRanges))
    h2 = await client.call('session.history', { sessionId, maxMessages: 100000 })
    landed = h2.events.map((e) => e.event ?? e).filter((e) => e.type === 'compaction/end').length
  }

  for (let i = 0; i < SETTLE_TURNS; i += 1) {
    await prompt(client, sessionId, `Reply with exactly: OK-${i + 1}`)
  }
  const postCompressPressure = (await pressure(client, sessionId)).projectedTokens ?? null

  await prompt(client, sessionId, queryTurn.text)

  const h3 = await client.call('session.history', { sessionId, maxMessages: 100000 })
  const events = h3.events.map((e) => e.event ?? e)

  // calls + usage
  const calls = []
  for (const ev of events) {
    const d = ev.data ?? {}
    if (ev.type === 'assistant/message' && d.usage) {
      calls.push({
        seq: ev.seq, turn: d.turn, step: d.step,
        usage: { uncachedInputTokens: d.usage.uncachedInputTokens ?? d.usage.inputTokens ?? 0, cacheReadTokens: d.usage.cacheReadTokens ?? 0, outputTokens: d.usage.outputTokens ?? 0 },
        prevSeq: ev.seq > 0 ? ev.seq - 1 : 0,
      })
    }
  }
  const maxTurn = Math.max(0, ...calls.map((c) => c.turn))

  // compaction evidence (durable log; the arc_status equivalent)
  const summaryText = (summary) => Array.isArray(summary)
    ? summary.filter((b) => b?.type === 'text').map((b) => b.text).join('')
    : String(summary ?? '')
  const compactions = []
  for (const ev of events) {
    if (ev.type !== 'compaction/summary') continue
    const d = ev.data ?? {}
    const text = summaryText(d.summary)
    compactions.push({
      compactionId: d.compactionId, shadowedRange: d.shadowedRange ?? null,
      shadowedTokenCount: d.shadowedTokenCount ?? null, tier: d.tier ?? null,
      summaryChars: text.length, summaryHead: text.slice(0, 200),
    })
  }

  // query-turn corpora + tool accounting
  const answerCorpus = []
  const toolResults = []
  const toolCalls = { search_context: 0, decompress: 0, other: {} }
  for (const ev of events) {
    const d = ev.data ?? {}
    if ((d.turn ?? 0) <= maxTurn - 1) continue
    if (ev.type === 'assistant/message') {
      for (const block of d.message?.content ?? []) if (block.type === 'text') answerCorpus.push(block.text)
    }
    if (ev.type === 'tool/call') {
      if (d.name === 'search_context' || d.name === 'decompress') toolCalls[d.name] += 1
      else toolCalls.other[d.name] = (toolCalls.other[d.name] ?? 0) + 1
    }
    if (ev.type === 'tool/result') {
      let text = ''
      for (const outer of d.message?.content ?? []) for (const inner of outer.content ?? []) if (inner.type === 'text') text += inner.text + '\n'
      toolResults.push({ seq: ev.seq, text })
    }
  }

  // scoring: bench contract (answer + tool corpus) and answer-only detail
  const scorable = script.facts.filter((f) => f.category !== 'trap')
  const scoring = scoreRecall(script.facts, answerCorpus.join('\n') + '\n' + toolResults.map((t) => t.text).join('\n'))
  const answerOnly = scoreRecall(script.facts, answerCorpus.join('\n'))
  const shadowedIds = new Set(plants.slice(0, COMPRESS_TURNS).flatMap((t) => t.factIds ?? []))
  const perFact = scoring.perFact.map((pf) => {
    const fact = script.facts.find((f) => f.id === pf.id)
    let firstToolHit = null
    for (const [idx, tr] of toolResults.entries()) {
      if (factMatches(fact, tr.text)) { firstToolHit = idx + 1; break }
    }
    return { ...pf, surface: shadowedIds.has(pf.id) ? 'shadowed' : 'live', firstToolHit }
  })
  const byCategory = {}
  const bySurfaceCategory = {}
  for (const pf of perFact) {
    byCategory[pf.category] ??= { recalled: 0, total: 0 }
    byCategory[pf.category].total += 1
    if (pf.hit) byCategory[pf.category].recalled += 1
    bySurfaceCategory[pf.surface] ??= {}
    bySurfaceCategory[pf.surface][pf.category] ??= { recalled: 0, total: 0 }
    bySurfaceCategory[pf.surface][pf.category].total += 1
    if (pf.hit) bySurfaceCategory[pf.surface][pf.category].recalled += 1
  }

  const ledger = buildLedger(calls, events.filter((e) => e.type === 'compaction/end').map((e) => ({ afterSeq: e.seq })))
  const shadowedRatio = prePressure && postCompressPressure ? {
    preProjected: prePressure, postProjected: postCompressPressure,
    dropped: prePressure - postCompressPressure, droppedFraction: (prePressure - postCompressPressure) / prePressure,
    ledgerShadowedTokens: compactions.reduce((a, c) => a + (c.shadowedTokenCount ?? 0), 0),
  } : null

  return {
    arm, locale, queryMode: queryMode === 'recovery' ? 'recovery' : 'blind', seed,
    sessionId, agentPreset: created.agentPreset,
    plantPressure,
    compress: {
      instructedRanges: targetRanges, rangesLanded: landed, retried: compressRetried,
      // The web-app contextPressure projection does not consume ARC's
      // shadowedTokenCount subtraction (verified against RQ2 beta.4 behavior),
      // so shadowing evidence is the durable ledger + per-call prompt sizes.
      plantTurns: plants.length, turnsCompressed: COMPRESS_TURNS,
      designShadowedFractionOfPlantTurns: COMPRESS_TURNS / plants.length,
      ledgerShadowedTokens: compactions.reduce((a, c) => a + (c.shadowedTokenCount ?? 0), 0),
    },
    compactions, pressure: shadowedRatio,
    result: {
      recall: scoring.score, recallRate: scoring.recallRate, trapLeaks: scoring.trapLeaks, unknownLines: scoring.unknownLines,
      answerOnlyRecall: answerOnly.score, byCategory, bySurfaceCategory, perFact,
      toolCalls: { search_context: toolCalls.search_context, decompress: toolCalls.decompress, other: toolCalls.other },
      calls: calls.length, ledger: ledger.totals,
      perCall: ledger.series.map((s) => ({ turn: s.turn, step: s.step, promptTokens: s.uncachedInputTokens + s.cacheReadTokens, outputTokens: s.outputTokens })),
      queryPromptTokens: calls.length > 0 ? calls[calls.length - 1].usage.uncachedInputTokens + calls[calls.length - 1].usage.cacheReadTokens : null,
    },
  }
}

async function live() {
  const client = makeClient(URL)
  const arms = (process.env.RQ3_ARMS ?? DEFAULT_ARMS).split(',')
  const started = new Date().toISOString()
  const sessions = []
  let used = 0
  let stopped = null
  for (const arm of arms) {
    // A session needs >= plant+compress+settle+query calls; refuse to open a
    // new one when the minimum need would breach the hard budget.
    const minNeed = STAGES + 1 + 1 + SETTLE_TURNS + 1
    if (used + minNeed > BUDGET) { stopped = { reason: 'budget', used, budget: BUDGET, armNotStarted: arm }; break }
    console.log(`[${arm}] starting (budget used ${used}/${BUDGET})`)
    try {
      const report = await runArm(client, arm, used)
      used += report.result.calls
      sessions.push(report)
      const f = resolve(OUT_DIR, `rq3-${arm}-${started.replace(/[:.]/g, '-')}.json`)
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(f, JSON.stringify(report, null, 2) + '\n')
      console.log(`[${arm}] recall ${report.result.recall} shadowed ${(report.pressure?.droppedFraction * 100).toFixed(1)}% calls ${report.result.calls} -> ${f}`)
    } catch (err) {
      sessions.push({ arm, error: String(err.message ?? err) })
      console.error(`[${arm}] FAILED: ${err.message}`)
    }
  }
  const summary = {
    mode: 'live', generatedAt: new Date().toISOString(), budget: { cap: BUDGET, used }, stopped,
    sessions: sessions.map((s) => s.error ? { arm: s.arm, error: s.error } : {
      arm: s.arm, recall: s.result.recall, calls: s.result.calls,
      byCategory: s.result.byCategory, trapLeaks: s.result.trapLeaks.length,
      tools: s.result.toolCalls,
    }),
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const f = resolve(OUT_DIR, `rq3-matrix-${started.replace(/[:.]/g, '-')}.json`)
  writeFileSync(f, JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ file: f, budgetUsed: used, stopped }, null, 2))
}

if (process.argv[2] === 'offline') offline()
else await live()
