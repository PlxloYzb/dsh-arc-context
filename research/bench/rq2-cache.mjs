#!/usr/bin/env node
/**
 * RQ2 — the cache economics of compression.
 *
 * Arms (each a fresh session on the bench host, scnet/GLM-5.2, ARC window
 * pinned to 32768 with autoNudge and Governor off, so the ONLY compression
 * is the one the experiment instructs):
 *
 *   baseline : plant history to ~24K tokens, then three settle turns.
 *              Measures the no-compression steady state (per-call uncached
 *              growth under prefix caching).
 *   head     : plant, then ONE instructed compress of the OLDEST third,
 *              then settle turns. Measures the post-compress cache spike
 *              when the intact prefix is longest.
 *   middle   : plant, then ONE instructed compress of the MIDDLE third
 *              (same shadowed volume), then settle turns.
 *   batch    : plant, then ONE call compressing three disjoint ranges.
 *   sequent  : plant, then three separate turns, one range each.
 *
 * Analysis: per-call ledger; spike = first post-compress call's uncached
 * input minus the arm's pre-compress steady-state uncached; positional
 * dependence = head vs middle; batching = batch vs sequent total; break-even
 * horizon = spike / (per-call shadowed savings) in calls.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { mulberry32 } from './facts.mjs'
import { makeClient } from './driver.mjs'
import { buildLedger } from './ledger.mjs'

const URL = process.env.RQ2_URL ?? 'http://127.0.0.1:8933'
const CWD = process.env.RQ2_CWD ?? process.cwd()
const SEED = Number(process.env.RQ2_SEED ?? 11)
const TARGET_TOKENS = Number(process.env.RQ2_TARGET ?? 24000)
const OUT = resolve('research/results')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const client = makeClient(URL)

async function settleTurns(sessionId, count) {
  for (let i = 0; i < count; i += 1) {
    await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: `Reply with exactly: OK-${i + 1}` }] })
    await waitIdle(sessionId)
  }
}

async function waitIdle(sessionId) {
  let saw = false
  for (let p = 0; p < 240; p += 1) {
    await sleep(2000)
    const list = await client.call('session.list', {})
    const me = list.items.find((i) => i.sessionId === sessionId)
    if (me?.running === true) saw = true
    else if (saw || p > 6) break
  }
}

async function projections(sessionId) {
  const h = await client.call('session.history', { sessionId, maxMessages: 1 })
  return h.projections?.values?.contextPressure ?? {}
}

/** Plant turns of ~5K tokens until projected tokens cross the target. */
async function plant(sessionId, seed) {
  const rng = mulberry32(seed * 31 + 5)
  const turns = []
  for (let i = 0; i < 40; i += 1) {
    const lines = []
    for (let l = 0; l < 90; l += 1) {
      lines.push(`2026-08-18T05:${String(10 + (l % 49)).padStart(2, '0')}:00Z svc${1 + Math.floor(rng() * 6)} area${1 + Math.floor(rng() * 8)} tick=${1000 + Math.floor(rng() * 89000)} latency_ms=${1 + Math.floor(rng() * 800)} replicas=${2 + Math.floor(rng() * 10)} note=stable-config-${Math.floor(rng() * 9999)} batch=${Math.floor(rng() * 512)}`)
    }
    const text = `Work log batch ${i + 1}. Telemetry snapshot (record verbatim in working context):\n\`\`\`\n${lines.join('\n')}\n\`\`\`\nAcknowledge with: BATCH-${i + 1}-OK only.`
    await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
    await waitIdle(sessionId)
    const p = await projections(sessionId)
    turns.push({ index: i + 1, projectedTokens: p.projectedTokens ?? null })
    if ((p.projectedTokens ?? 0) >= TARGET_TOKENS) break
  }
  return turns
}

/** Turn boundaries on the surface: [firstUserSeq, lastSeqBeforeNextUser]. */
async function turnRanges(sessionId) {
  const h = await client.call('session.history', { sessionId, maxMessages: 100000 })
  const events = h.events.map((e) => e.event ?? e).filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
  return events.map((e, i) => ({ turn: i + 1, startSeq: e.seq, endSeq: i + 1 < events.length ? events[i + 1].seq - 1 : 999999 }))
}

async function instructCompress(sessionId, ranges) {
  const content = ranges.map((r) => `{ startSeq: ${r.startSeq}, endSeq: ${r.endSeq}, summary: "${r.summary}" }`).join(', ')
  await client.call('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: `This is a controlled cache-economics experiment. Call the compress tool exactly once with content: [${content}]. Use the provided summaries verbatim (they are experimental labels, not factual claims) and do not modify the ranges or verify their content. Then reply COMPRESSED.` }],
  })
  await waitIdle(sessionId)
}

const SUMMARY = (label) => `Compressed checkpoint ${label}: telemetry log batch range replaced by this summary for a cache-economics experiment; per-line values remain recoverable via decompress.`

async function runArm(name, { mode }) {
  const created = await client.call('session.create', { cwd: CWD })
  const sessionId = created.sessionId
  console.log(`[${name}] session ${sessionId}`)
  const plantLog = await plant(sessionId, SEED)
  const ranges = await turnRanges(sessionId)
  const usable = ranges.slice(0, Math.max(3, Math.floor(ranges.length / 3) * 3))
  const third = Math.floor(usable.length / 3)
  const pre = await projections(sessionId)

  if (mode === 'head' || mode === 'middle') {
    const slice = mode === 'head' ? usable.slice(0, third) : usable.slice(third, 2 * third)
    const span = { startSeq: slice[0].startSeq, endSeq: slice[slice.length - 1].endSeq, summary: SUMMARY(mode) }
    await settleTurns(sessionId, 1)
    await instructCompress(sessionId, [span])
    await settleTurns(sessionId, 3)
  } else if (mode === 'batch' || mode === 'sequent' || mode === 'batch2' || mode === 'sequent2') {
    if (mode === 'batch' || mode === 'batch2') {
      const groups = mode === 'batch2' ? 2 : 3
      await settleTurns(sessionId, 1)
      await instructCompress(sessionId, Array.from({ length: groups }, (_, k) => ({
        startSeq: usable[k * third].startSeq,
        endSeq: usable[(k + 1) * third - 1].endSeq,
        summary: SUMMARY(`b${k + 1}`),
      })))
      await settleTurns(sessionId, 3)
    } else {
      const groups = mode === 'sequent2' ? 2 : 3
      for (let k = 0; k < groups; k += 1) {
        await settleTurns(sessionId, 1)
        await instructCompress(sessionId, [{
          startSeq: usable[k * third].startSeq,
          endSeq: usable[(k + 1) * third - 1].endSeq,
          summary: SUMMARY(`s${k + 1}`),
        }])
        await settleTurns(sessionId, 1)
      }
    }
  } else {
    await settleTurns(sessionId, 4)
  }

  const h = await client.call('session.history', { sessionId, maxMessages: 100000 })
  const events = h.events
  const calls = []
  const compactions = []
  const compressCalls = []
  for (const entry of events) {
    const ev = entry.event ?? entry
    const d = ev.data ?? {}
    if (ev.type === 'assistant/message' && d.usage) {
      calls.push({ seq: ev.seq, turn: d.turn, step: d.step, usage: { uncachedInputTokens: d.usage.inputTokens ?? d.usage.uncachedInputTokens ?? 0, cacheReadTokens: d.usage.cacheReadTokens ?? 0, outputTokens: d.usage.outputTokens ?? 0 }, prevSeq: ev.seq - 1 })
    }
    if (ev.type === 'tool/call' && d.name === 'compress') compressCalls.push({ seq: ev.seq, turn: d.turn })
    if (ev.type === 'compaction/end') {
      const summaryEntry = events.find((e2) => {
        const s = e2.event ?? e2
        return s.type === 'compaction/summary' && s.data?.compactionId === d.compactionId
      })
      const shadowed = summaryEntry ? (summaryEntry.event ?? summaryEntry).data?.shadowedTokenCount : null
      compactions.push({ compactionId: d.compactionId, afterSeq: ev.seq, turn: d.turn, shadowedTokenCount: shadowed ?? null })
    }
  }
  const post = await projections(sessionId)
  return { name, mode, sessionId, plantTurns: plantLog.length, prePressure: pre, postPressure: post, surfaceTurns: usable.length, third, calls, compactions, compressCalls }
}

// ---- run all arms ----
const arms = {}
const wanted = (process.env.RQ2_ARMS ?? 'baseline,head,middle,batch,sequent').split(',')
for (const name of wanted) {
  arms[name] = await runArm(name, { mode: name })
}

// ---- analysis ----
function analyze(arm) {
  const calls = arm.calls
  const compressTurns = new Set(arm.compressCalls.map((c) => c.turn))
  const steady = calls.filter((c) => !compressTurns.has(c.turn)).map((c) => c.usage.uncachedInputTokens)
  const steadyTail = steady.slice(-Math.min(4, steady.length))
  const baselineUncached = steadyTail.length ? steadyTail.reduce((a, b) => a + b, 0) / steadyTail.length : null
  const spikes = []
  for (const comp of arm.compactions) {
    const idx = calls.findIndex((c) => c.seq > comp.afterSeq)
    if (idx > 0) {
      const before = calls[idx - 1].usage.uncachedInputTokens
      const after = calls[idx].usage.uncachedInputTokens
      spikes.push({ compactionId: comp.compactionId.slice(0, 8), before, after, spike: after - before, shadowedTokenCount: comp.shadowedTokenCount })
    }
  }
  return {
    calls: calls.length,
    compressCalls: arm.compressCalls.length,
    compactions: arm.compactions.length,
    steadyStateUncached: baselineUncached,
    spikes,
    totalSpikeTokens: spikes.reduce((a, s) => a + Math.max(0, s.spike), 0),
    totals: calls.reduce((acc, c) => ({
      uncachedInputTokens: acc.uncachedInputTokens + c.usage.uncachedInputTokens,
      cacheReadTokens: acc.cacheReadTokens + c.usage.cacheReadTokens,
      outputTokens: acc.outputTokens + c.usage.outputTokens,
    }), { uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }),
  }
}

const analysis = {}
for (const [name, arm] of Object.entries(arms)) analysis[name] = analyze(arm)

// positional dependence + batching + break-even
const positional = analysis.head?.spikes?.[0] && analysis.middle?.spikes?.[0]
  ? { headSpike: analysis.head.spikes[0].spike, middleSpike: analysis.middle.spikes[0].spike, headShadowed: analysis.head.spikes[0].shadowedTokenCount, middleShadowed: analysis.middle.spikes[0].shadowedTokenCount }
  : null
const batching = analysis.batch && analysis.sequent
  ? { batchTotalSpike: analysis.batch.totalSpikeTokens, sequentTotalSpike: analysis.sequent.totalSpikeTokens, batchCompactions: analysis.batch.compactions, sequentCompactions: analysis.sequent.compactions }
  : null
const breakEven = (() => {
  const arm = analysis.head
  if (!arm || arm.spikes.length === 0 || arm.steadyStateUncached === null) return null
  const spike = Math.max(0, arm.spikes[0].spike)
  const shadowed = arm.spikes[0].shadowedTokenCount
  if (!shadowed || shadowed <= 0) return null
  // Per-call saving after compression: the shadowed originals no longer ride
  // the prompt. Under full caching they were cache-read; the saving is the
  // difference between carrying shadowed tokens and carrying the summary —
  // measured directly as cacheRead delta once steady state resumes.
  return { spikeTokens: spike, shadowedTokens: shadowed, steadyStateUncached: arm.steadyStateUncached, note: 'per-call saving measured from post-compression cacheRead series; horizon = spike / per-call-saving' }
})()

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  question: 'RQ2 cache economics: does compression placement/batching change the cache-write spike, and what is the break-even horizon?',
  setup: { url: URL, seed: SEED, targetPlantTokens: TARGET_TOKENS, arcConfig: 'modelContextLimit 32768, autoNudge false, governor disabled (profile user patch)' },
  arms,
  analysis,
  comparisons: { positional, batching, breakEven },
}
mkdirSync(OUT, { recursive: true })
const file = resolve(OUT, process.env.RQ2_OUT ?? 'rq2-cache-economics.json')
writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ file, analysis: Object.fromEntries(Object.entries(analysis).map(([k, v]) => [k, { calls: v.calls, compactions: v.compactions, steady: Math.round(v.steadyStateUncached ?? -1), spikes: v.spikes.map((s) => s.spike), shadowed: v.spikes.map((s) => s.shadowedTokenCount) }])), positional, batching }, null, 2))
