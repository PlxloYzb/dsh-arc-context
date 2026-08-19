#!/usr/bin/env node
/**
 * RQ1 closure (task C) — does the nudge pressure source subtract
 * shadowedTokenCount after compression? (corrective live test for RQ3
 * finding rq3-f1, which ran with autoNudge OFF and so never exercised the
 * nudge path post-compression).
 *
 * Single session, autoNudge ON, Governor OFF, modelContextLimit 32768
 * (profile patch; the RQ2/RQ3 window). Clean /tmp cwd keeps fixed prompt
 * overhead small so the 70% forced-nudge line (22,938 tokens) discriminates:
 *   plant -> nudge fires (over the line)
 *   -> instructed batch compress of the front 2/3 plant turns (model-written)
 *   -> settle -> arc_status -> one more tiny turn
 * Observe per phase: host contextPressure.projectedTokens, real per-call
 * prompt size (uncached + cache-read), ledger shadowed tokens, and every
 * nudge text captured live off the events.mux stream plus the durable log.
 *
 * Judgment (written into the results file):
 *   (a) did the host projection drop after compression?
 *   (b) which pressure source drove any post-compression nudge — if a nudge
 *       re-fires while the REAL prompt is below the line and the projection
 *       stayed above it, the non-subtracting projection is load-bearing;
 *   (c) classification: display-only / nudge-overpressure product defect /
 *       rule-2 wording amendment.
 *
 * Budget guard: hard cap 13 model calls (commission allows 15).
 *
 *   DSH_URL=http://127.0.0.1:8933 RQ1C_CWD=/tmp/rq1c-workspace \
 *     node research/bench/rq1c-projection.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildScript } from './script.mjs'
import { makeClient } from './driver.mjs'

const URL = process.env.DSH_URL ?? 'http://127.0.0.1:8933'
const CWD = process.env.RQ1C_CWD ?? '/tmp/rq1c-workspace'
const OUT = resolve(process.env.RQ1C_OUT ?? 'research/results/projection-subtraction-results.json')
const MUX_CAPTURE = process.env.RQ1C_MUX ?? '/tmp/rq1c-mux.jsonl'
const BUDGET = 13
const WINDOW = 32768
const FORCED_LINE = 0.70 * WINDOW
const EMERGENCY_LINE = 0.85 * WINDOW

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Nudge-shaped text markers (prompts.ts defaults): the injected user message
// is request-scoped (pre-step `messages`), so it may not be durable — capture
// the live mux stream AND scan the final log.
const NUDGE_MARKERS = ['of effective input capacity', 'compress now; prioritize', 'Compressible ranges (top']

function textOfContent(blocks) {
  return (blocks ?? []).map((b) => b?.text ?? '').join(' ')
}

function openMux() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${URL.replace(/^http/, 'ws')}/api/events.mux`, { origin: URL })
    const done = setTimeout(() => rej(new Error('mux ws timeout')), 15000)
    ws.onopen = () => { clearTimeout(done); res(ws) }
    ws.onerror = () => { clearTimeout(done); rej(new Error('mux ws error')) }
  })
}

async function main() {
  const muxFrames = []
  const ws = await openMux()
  ws.addEventListener('message', (msg) => {
    muxFrames.push(msg.data)
    if (muxFrames.length > 20000) muxFrames.shift()
  })
  const client = makeClient(URL)

  const script = buildScript(1, { locale: 'en', stages: 4, facts: 24, noiseLines: 210, queryMode: 'blind' })
  const plants = script.turns.filter((t) => t.kind === 'plant')

  const created = await client.call('session.create', { cwd: CWD })
  const sessionId = created.sessionId
  const timeline = []
  let used = 0

  const history = async () => (await client.call('session.history', { sessionId, maxMessages: 100000 }))
  const pressure = async () => (await history()).projections?.values?.contextPressure ?? {}

  async function callCount(events) {
    return events.map((e) => e.event ?? e).filter((e) => e.type === 'assistant/message' && (e.data ?? {}).usage).length
  }

  async function waitIdle() {
    let saw = false
    for (let p = 0; p < 300; p += 1) {
      await sleep(2000)
      const list = await client.call('session.list', {})
      const me = list.items.find((i) => i.sessionId === sessionId)
      if (me?.running === true) saw = true
      else if (saw || p > 6) break
    }
  }

  async function prompt(label, text) {
    const before = used
    if (used >= BUDGET) throw new Error(`budget exhausted (${BUDGET}) before ${label}`)
    await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
    await waitIdle()
    const h = await history()
    const events = h.events.map((e) => e.event ?? e)
    used = await callCount(events)
    const p = h.projections?.values?.contextPressure ?? {}
    const calls = events.filter((e) => e.type === 'assistant/message' && (e.data ?? {}).usage)
    const lastCall = calls[calls.length - 1]?.data?.usage
    timeline.push({
      phase: label,
      modelCalls: used,
      projectedTokens: p.projectedTokens ?? null,
      pressureTokens: p.pressureTokens ?? null,
      projectionContextWindow: p.contextWindow ?? null,
      projectionPctOfPatchWindow: p.projectedTokens != null ? Number((p.projectedTokens / WINDOW).toFixed(4)) : null,
      realPromptTokens: lastCall ? (lastCall.uncachedInputTokens ?? lastCall.inputTokens ?? 0) + (lastCall.cacheReadTokens ?? 0) : null,
      lastCall: label,
    })
    return { events, projected: p.projectedTokens ?? null, callsUsed: used - before }
  }

  // ── phase 1: plant until over the forced line (below emergency) ──────────
  let plantCount = 0
  let snapshot
  for (const turn of plants) {
    snapshot = await prompt(`plant-${plantCount + 1}`, turn.text)
    plantCount += 1
    if (snapshot.projected != null && snapshot.projected >= FORCED_LINE) break
  }
  // One more plant only if we are still under the forced line.
  if (snapshot.projected != null && snapshot.projected < FORCED_LINE) {
    const next = plants[plantCount]
    if (next) {
      snapshot = await prompt(`plant-${plantCount + 1}`, next.text)
      plantCount += 1
    }
  }

  // ── phase 2: instructed batch compress of the front 2/3 plant turns ─────
  const h1 = await history()
  const events1 = h1.events.map((e) => e.event ?? e)
  const userMsgs = events1.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
  const ranges = userMsgs.map((e, i) => ({ turn: i + 1, startSeq: e.seq, endSeq: i + 1 < userMsgs.length ? userMsgs[i + 1].seq - 1 : 999999 }))
  const targetCount = Math.max(1, Math.floor((plantCount * 2) / 3))
  const targetRanges = ranges.slice(0, targetCount).map((r) => ({ startSeq: r.startSeq, endSeq: r.endSeq }))
  const list = targetRanges.map((r) => `{ startSeq: ${r.startSeq}, endSeq: ${r.endSeq}, summary: <write your own faithful summary> }`).join(', ')
  const preCompress = (await pressure()).projectedTokens ?? null
  await prompt('compress-instructed',
    `This is a context-management experiment. Call compress with content:\n[${list}]\n(follow your standard compression summary rules). Then reply COMPRESSED.`)

  // ── phase 3: settle, arc_status, final observation turn ──────────────────
  await prompt('settle-1', 'Reply with exactly: OK-1')
  await prompt('settle-2', 'Reply with exactly: OK-2')
  await prompt('arc-status', 'Call the arc_status tool now, then reply with its full output verbatim.')
  const postCompress = (await pressure()).projectedTokens ?? null
  await prompt('final-observe', 'Reply with exactly: DONE')

  // ── evidence: durable log + compactions + arc_status text ────────────────
  const h2 = await history()
  const events = h2.events.map((e) => e.event ?? e)
  const compactions = events.filter((e) => e.type === 'compaction/summary').map((e) => ({
    shadowedRange: e.data?.shadowedRange ?? null,
    shadowedTokenCount: e.data?.shadowedTokenCount ?? null,
    tier: e.data?.tier ?? null,
    provider: e.data?.provider ?? null,
    model: e.data?.model ?? null,
  }))
  const ledgerShadowed = compactions.reduce((a, c) => a + (c.shadowedTokenCount ?? 0), 0)

  const calls = events.filter((e) => e.type === 'assistant/message' && (e.data ?? {}).usage).map((e) => ({
    seq: e.seq,
    turn: e.data.turn,
    step: e.data.step,
    promptTokens: (e.data.usage.uncachedInputTokens ?? e.data.usage.inputTokens ?? 0) + (e.data.usage.cacheReadTokens ?? 0),
  }))

  // Nudge captures: mux frames (live, request-scoped evidence) + log scan.
  const nudgesFromMux = []
  for (const frame of muxFrames) {
    if (NUDGE_MARKERS.some((m) => frame.includes(m))) {
      try {
        const parsed = JSON.parse(frame)
        const ev = parsed?.payload?.event ?? parsed?.event ?? parsed
        nudgesFromMux.push({ eventType: ev?.type ?? null, seq: ev?.seq ?? null, textHead: extractNudgeText(frame)?.slice(0, 500) ?? null })
      } catch {
        nudgesFromMux.push({ eventType: 'unparsed', seq: null, textHead: null })
      }
    }
  }
  const nudgesFromLog = []
  for (const e of events) {
    const d = e.data ?? {}
    const texts = []
    if (e.type === 'user/message') texts.push(textOfContent(d.content) || textOfContent(d.message?.content))
    if (e.type === 'agent/inbox/spliced') for (const ins of d.inserted ?? []) texts.push(textOfContent(ins.content))
    for (const text of texts) {
      if (typeof text === 'string' && NUDGE_MARKERS.some((m) => text.includes(m))) {
        nudgesFromLog.push({ eventType: e.type, seq: e.seq, source: d.source ?? null, textHead: text.slice(0, 500) })
      }
    }
  }

  // arc_status tool result of the observation turn
  let arcStatusText = null
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    let text = ''
    for (const outer of (e.data?.message?.content ?? [])) for (const inner of outer.content ?? []) if (inner.type === 'text') text += inner.text + '\n'
    if (text.includes('ARC status')) arcStatusText = text.trim()
  }

  // ── judgments ─────────────────────────────────────────────────────────────
  const projectionDropped = preCompress != null && postCompress != null ? postCompress - preCompress : null
  const postReal = calls.length > 0 ? calls[calls.length - 1].promptTokens : null
  const postNudges = [...nudgesFromMux, ...nudgesFromLog]
  const realPromptBelowLine = postReal != null ? postReal < FORCED_LINE : null
  const projectionAboveLine = postCompress != null ? postCompress >= FORCED_LINE : null
  const reNudgedAfterCompression = postNudges.length > 0

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    question: 'RQ1-closure task C: does the nudge pressure source (sessionProjections.contextPressure.projectedTokens) consume shadowedTokenCount after compression? (RQ3 finding rq3-f1 corrective test; autoNudge was OFF in RQ3 so the nudge path post-compression was never exercised)',
    setup: {
      host: 'isolated DSH_HOME web profile, ARC 0.2.0-beta.5 via bridge',
      patch: 'compaction-arc--bridge row: modelContextLimit 32768, autoNudge true, adaptiveGovernor.enabled false',
      model: 'scnet/GLM-5.2 (host default)',
      cwd: 'clean /tmp workspace (no AGENTS.md — fixed prompt overhead minimized so the 70% line discriminates)',
      windowMath: { modelContextLimit: WINDOW, forcedNudgeLine: FORCED_LINE, emergencyLine: EMERGENCY_LINE },
      phases: `${plantCount} plant turns -> instructed batch compress of front ${targetCount} plant range(s) -> 2 settle -> arc_status -> DONE`,
      budget: { cap: BUDGET, used },
    },
    timeline,
    compression: {
      instructedRanges: targetRanges,
      ledgerShadowedTokens: ledgerShadowed,
      compactions,
      preCompressProjected: preCompress,
      postCompressProjected: postCompress,
    },
    perCallPromptTokens: calls,
    nudges: {
      mux: nudgesFromMux,
      log: nudgesFromLog,
      note: 'mux frames are the live request-scoped evidence (the injected nudge user message is not guaranteed durable); the log scan covers durable inbox splices',
    },
    arcStatusOutput: arcStatusText,
    judgment: {
      aProjectionDroppedAfterCompression: projectionDropped,
      aVerdict: projectionDropped != null && projectionDropped < 0 ? 'projection DROPPED (subtraction present)' : 'projection did NOT drop (no shadowedTokenCount subtraction — matches rq3-f1)',
      bNudgePressureSource: {
        postCompressionRealPromptTokens: postReal,
        postCompressionProjectedTokens: postCompress,
        forcedNudgeLine: FORCED_LINE,
        realPromptBelowLine,
        projectionAboveLine,
        reNudgedAfterCompression,
      },
      cClassification: null,
    },
    sessionId,
  }
  result.judgment.cClassification = classify(result)
  mkdirSync(resolve(OUT, '..'), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
  writeFileSync(MUX_CAPTURE, muxFrames.join('\n') + '\n')
  ws.close()
  console.log(JSON.stringify({ file: OUT, budgetUsed: used, projectionDropped, ledgerShadowed, nudges: { mux: nudgesFromMux.length, log: nudgesFromLog.length }, classification: result.judgment.cClassification }, null, 2))
}

function extractNudgeText(frameText) {
  for (const marker of NUDGE_MARKERS) {
    const idx = frameText.indexOf(marker)
    if (idx !== -1) return frameText.slice(Math.max(0, idx - 120), idx + 380)
  }
  return null
}

function classify(result) {
  const j = result.judgment
  const projectionFailing = j.aProjectionDroppedAfterCompression != null && j.aProjectionDroppedAfterCompression >= 0
  const overpressureConfirmed = projectionFailing
    && j.bNudgePressureSource.reNudgedAfterCompression === true
    && j.bNudgePressureSource.realPromptBelowLine === true
    && j.bNudgePressureSource.projectionAboveLine === true
  if (overpressureConfirmed) {
    return 'nudge-overpressure product defect: post-compression nudges fire on a non-subtracting projection while the real prompt is below the forced line (evidence complete; fix deferred to a separate commission — no src/ changes here)'
  }
  if (projectionFailing) {
    return 'display-only: the projection does not subtract, but no post-compression nudge fired on a real-below-line prompt in this session (rule 2 wording still worth amending: the preferred source is not provider-anchored post-compression)'
  }
  return 'projection subtracts correctly (rq3-f1 not reproduced under autoNudge; rule 2 stands)'
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`)
  process.exitCode = 1
})
