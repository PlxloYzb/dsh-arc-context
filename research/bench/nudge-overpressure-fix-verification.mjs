#!/usr/bin/env node
/**
 * Release verification — nudge over-pressure fix. Replays task C against the
 * beta.6 compression-aware pressure reader and proves post-compression
 * emergency nudges are absent while ordinary readings and arc_status use the
 * same projectedTokens − log-rebuilt-ledger calculation.
 *
 * Single session, autoNudge ON, Governor OFF, modelContextLimit 32768
 * (profile patch; the RQ2/RQ3 window). Clean /tmp cwd keeps fixed prompt
 * overhead small so the 70% forced-nudge line (22,938 tokens) discriminates:
 *   plant -> nudge fires (over the line)
 *   -> instructed batch compress of the front 2/3 plant turns (model-written)
 *   -> settle -> arc_status -> one more tiny turn
 * Observe per phase: host contextPressure.projectedTokens, durable ledger
 * shadowing, and session-filtered mux nudge events. Every post-compression
 * normal nudge is checked against its immediately preceding host projection
 * minus the ledger; every post-compression emergency nudge fails the run.
 *
 * Budget guard: hard cap 15 model calls (commission limit).
 *
 *   DSH_URL=http://127.0.0.1:8933 NUDGE_FIX_CWD=/tmp/nudge-overpressure-fix-workspace \
 *     node research/bench/nudge-overpressure-fix-verification.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildScript } from './script.mjs'
import { makeClient } from './driver.mjs'

const URL = process.env.DSH_URL ?? 'http://127.0.0.1:8933'
const CWD = process.env.NUDGE_FIX_CWD ?? '/tmp/nudge-overpressure-fix-workspace'
const OUT = resolve(process.env.NUDGE_FIX_OUT ?? 'research/results/nudge-overpressure-fix-verification.json')
const MUX_CAPTURE = process.env.NUDGE_FIX_MUX ?? '/tmp/nudge-overpressure-fix-mux.jsonl'
const BUDGET = 15
const WINDOW = 32768
const FORCED_LINE = 0.70 * WINDOW
const EMERGENCY_LINE = 0.85 * WINDOW

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    seq: e.seq,
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

  // Capture only this session's injected ARC nudges. The mux carries a
  // contextPressure projection for the same session/event stream, letting the
  // verification compare each displayed normal percentage with the precise
  // pre-injection host projection minus the ledger at that event boundary.
  const muxNudges = new Map()
  const muxPressure = []
  for (const frame of muxFrames) {
    try {
      const payload = JSON.parse(frame)?.payload
      if (payload?.sessionId !== sessionId) continue
      if (payload.type === 'session/projection' && payload.key === 'contextPressure') {
        const projectedTokens = payload.value?.projectedTokens
        if (typeof projectedTokens === 'number') muxPressure.push({ seq: payload.seq, projectedTokens })
      }
      const event = payload?.event
      if (event?.type !== 'user/message' || event.data?.source?.plugin !== 'arc-nudge') continue
      const text = textOfContent(event.data?.content)
      muxNudges.set(event.seq, { seq: event.seq, text })
    } catch { /* ignore a malformed or non-event mux frame */ }
  }
  muxPressure.sort((a, b) => a.seq - b.seq)
  const firstCompactionSeq = compactions[0]?.seq ?? null
  const shadowedAt = (seq) => compactions
    .filter((compaction) => compaction.seq < seq)
    .reduce((total, compaction) => total + (compaction.shadowedTokenCount ?? 0), 0)
  const projectionBefore = (seq) => muxPressure.filter((pressure) => pressure.seq < seq).at(-1) ?? null
  const nudgeEvents = [...muxNudges.values()].sort((a, b) => a.seq - b.seq).map((nudge) => {
    const displayedPct = Number(/ARC (\d+)%/.exec(nudge.text)?.[1] ?? NaN)
    const hostProjection = projectionBefore(nudge.seq)
    const ledgerAtNudge = shadowedAt(nudge.seq)
    const effectiveTokens = hostProjection === null ? null : Math.max(0, hostProjection.projectedTokens - ledgerAtNudge)
    const expectedPct = effectiveTokens === null ? null : Math.round((effectiveTokens / WINDOW) * 100)
    return {
      seq: nudge.seq,
      tier: nudge.text.includes('compress now') ? 'emergency' : 'normal',
      displayedPct,
      hostProjectedTokensBeforeNudge: hostProjection?.projectedTokens ?? null,
      ledgerShadowedAtNudge: ledgerAtNudge,
      effectiveTokens,
      expectedPct,
      textHead: nudge.text.slice(0, 500),
      postCompression: firstCompactionSeq !== null && nudge.seq > firstCompactionSeq,
    }
  })

  // arc_status tool result of the observation turn
  let arcStatusText = null
  let arcStatusSeq = null
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    let text = ''
    for (const outer of (e.data?.message?.content ?? [])) for (const inner of outer.content ?? []) if (inner.type === 'text') text += inner.text + '\n'
    if (text.includes('ARC status')) {
      arcStatusText = text.trim()
      arcStatusSeq = e.seq
    }
  }

  const postCompressionNudges = nudgeEvents.filter((nudge) => nudge.postCompression)
  const postCompressionEmergencyNudges = postCompressionNudges.filter((nudge) => nudge.tier === 'emergency')
  const normalPercentagesMatch = postCompressionNudges
    .filter((nudge) => nudge.tier === 'normal')
    .every((nudge) => nudge.expectedPct !== null && Math.abs(nudge.displayedPct - nudge.expectedPct) <= 1)
  const statusProjection = arcStatusSeq === null ? null : projectionBefore(arcStatusSeq)
  const statusLedger = arcStatusSeq === null ? null : shadowedAt(arcStatusSeq)
  const statusExpectedTokens = statusProjection === null || statusLedger === null
    ? null
    : Math.max(0, statusProjection.projectedTokens - statusLedger)
  const statusObservedTokens = Number(/estimated context: (\d+) \/ \d+ \(\d+%\)/.exec(arcStatusText ?? '')?.[1] ?? NaN)
  const statusMatchesNudgeSource = statusExpectedTokens !== null && statusObservedTokens === statusExpectedTokens
  const assertions = {
    zeroPostCompressionEmergencyNudges: postCompressionEmergencyNudges.length === 0,
    allPostCompressionEmergencyNudgesRemainAboveEffective85Pct: postCompressionEmergencyNudges.every(
      (nudge) => nudge.expectedPct !== null && nudge.expectedPct >= EMERGENCY_LINE / WINDOW * 100,
    ),
    noPostCompressionEmergencyOverpressureArtifacts: postCompressionEmergencyNudges.length === 0
      || postCompressionEmergencyNudges.every(
        (nudge) => nudge.expectedPct !== null && nudge.expectedPct >= EMERGENCY_LINE / WINDOW * 100,
      ),
    normalPercentagesMatchCompressionAwareProjection: normalPercentagesMatch,
    arcStatusMatchesCompressionAwareProjection: statusMatchesNudgeSource,
    budgetWithinLimit: used <= BUDGET,
  }
  const failedAssertions = Object.entries(assertions)
    .filter(([name, passed]) => name !== 'zeroPostCompressionEmergencyNudges' && !passed)
    .map(([name]) => name)

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    question: 'Release verification: the ARC 0.2.0-beta.6 compression-aware pressure reader prevents post-compression emergency nudge over-pressure while preserving route-anchored context pressure.',
    setup: {
      host: 'isolated DSH_HOME web profile, ARC 0.2.0-beta.6 via bridge',
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
      effectivePostCompressProjected: postCompress === null ? null : Math.max(0, postCompress - ledgerShadowed),
    },
    perCallPromptTokens: calls,
    nudges: {
      events: nudgeEvents,
      note: 'session-filtered events.mux capture; each normal nudge is compared against its pre-injection contextPressure projection minus durable ledger shadowing',
    },
    arcStatus: {
      seq: arcStatusSeq,
      output: arcStatusText,
      hostProjectedTokensBeforeStatus: statusProjection?.projectedTokens ?? null,
      ledgerShadowedAtStatus: statusLedger,
      expectedEffectiveTokens: statusExpectedTokens,
      observedEffectiveTokens: Number.isNaN(statusObservedTokens) ? null : statusObservedTokens,
    },
    verification: assertions,
    sessionId,
  }
  mkdirSync(resolve(OUT, '..'), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
  writeFileSync(MUX_CAPTURE, muxFrames.join('\n') + '\n')
  ws.close()
  console.log(JSON.stringify({ file: OUT, budgetUsed: used, ledgerShadowed, postCompressionNudges: postCompressionNudges.length, ...assertions }, null, 2))
  if (failedAssertions.length > 0) throw new Error(`verification assertions failed: ${failedAssertions.join(', ')}`)
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`)
  process.exitCode = 1
})
