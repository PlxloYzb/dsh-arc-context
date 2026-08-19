#!/usr/bin/env node
/**
 * RQ5 — nudge compliance and escalation-ladder measurement.
 *
 * Run one live arm per freshly started isolated DSH host.  N/G use exactly
 * the same planted records and ordinary follow-up turns, but their DRIVER
 * prompts deliberately contain none of the contamination words checked by
 * assertNaturalPromptAudit().  ARC's persistent `arc-nudge` events are then
 * read from the durable session history; no observation prompt or extra model
 * call is used to ask about a nudge.
 *
 *   RQ5_ARM=N   node research/bench/rq5-compliance.mjs live
 *   RQ5_ARM=G80 node research/bench/rq5-compliance.mjs live
 *   RQ5_ARM=G88 node research/bench/rq5-compliance.mjs live
 *   RQ5_ARM=P   node research/bench/rq5-compliance.mjs live
 *   node research/bench/rq5-compliance.mjs consolidate
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateFacts, mulberry32, noiseBlock } from './facts.mjs'
import { makeClient } from './driver.mjs'
import { buildLedger } from './ledger.mjs'
import { scoreRecall } from './scorer.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const RESULTS = resolve(ROOT, 'results')
const BENCH_RESULTS = resolve(RESULTS, 'bench')
const FINAL = resolve(RESULTS, 'rq5-compliance-results.json')
const ARM = process.env.RQ5_ARM
const URL = process.env.RQ5_URL ?? 'http://127.0.0.1:8933'
const CWD = process.env.RQ5_CWD ?? `/tmp/rq5-compliance-${String(ARM ?? 'unknown').toLowerCase()}`
const WINDOW = 32768
const PER_ARM_BUDGET = 15
const GLOBAL_BUDGET = 60
const STAGES = 7
const NOISE_LINES = Number(process.env.RQ5_NOISE ?? 260)
const P_NOISE_LINES = Number(process.env.RQ5_P_NOISE ?? 80)
const SEED = Number(process.env.RQ5_SEED ?? 505)
const NATURAL_ARMS = new Set(['N', 'G80', 'G88'])
const ARMS = ['N', 'G80', 'G88', 'P']
const MAX_NEW_PROMPTS = Number(process.env.RQ5_MAX_NEW_PROMPTS ?? Number.MAX_SAFE_INTEGER)
const STATE_FILE = process.env.RQ5_STATE ?? `/tmp/rq5-${String(ARM ?? 'unknown').toLowerCase()}-state.json`
const FINALIZE_PARTIAL = process.env.RQ5_FINALIZE_PARTIAL === '1'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = (text) => createHash('sha256').update(text).digest('hex')
const eventOf = (entry) => entry.event ?? entry
const textOf = (content) => (content ?? []).flatMap((block) => {
  if (block?.type === 'text') return [block.text ?? '']
  return (block?.content ?? []).filter((nested) => nested?.type === 'text').map((nested) => nested.text ?? '')
}).join('\n')

// These are the only user-driver prompt fragments issued in N/G.  Do not
// relax this pattern: it mechanically guards the experimental contamination
// boundary named by the commission in both English and Chinese.
const FORBIDDEN_NATURAL_PROMPT = /\b(?:compress|compression|context|nudge|summar(?:y|ize|ization))\b|压缩|上下文|提示/iu

function safeScript(seed) {
  const rng = mulberry32(seed * 7919 + 13)
  const facts = generateFacts(seed, { facts: 24 }).filter((fact) => fact.category !== 'trap')
  const perStage = Math.ceil(facts.length / STAGES)
  const plants = []
  for (let stage = 0; stage < STAGES; stage += 1) {
    const records = facts.slice(stage * perStage, (stage + 1) * perStage)
    if (records.length === 0) continue
    plants.push({
      stage: stage + 1,
      factIds: records.map((record) => record.id),
      text: [
        `Operations ledger import ${stage + 1}/${STAGES}.`,
        'Reference records:',
        ...records.map((record) => `- [${record.id}] ${record.category === 'paraphrase' ? record.statement : record.needle}`),
        '',
        'Telemetry:',
        '```',
        noiseBlock(rng, NOISE_LINES),
        '```',
        '',
        `Reply exactly: ACK-${stage + 1}`,
      ].join('\n'),
    })
  }
  const questions = facts.map((fact) => `${fact.id}: ${fact.question}`).join('\n')
  const recall = `Do not call any tools. Give one exact answer for each record ID below. One line per ID. If unavailable, write UNKNOWN.\n${questions}`
  const ordinary = ['Reply exactly: PING-1', 'Reply exactly: PING-2', 'Reply exactly: PING-3']
  const proactivePlant = [
    'Operations ledger import.',
    'Reference records:',
    ...facts.map((record) => `- [${record.id}] ${record.category === 'paraphrase' ? record.statement : record.needle}`),
    '',
    'Telemetry:',
    '```',
    noiseBlock(mulberry32(seed * 1231 + 41), P_NOISE_LINES),
    '```',
    '',
    'Reply exactly: ACK-P',
  ].join('\n')
  return { facts, plants, proactivePlant, recall, ordinary }
}

function assertNaturalPromptAudit(script) {
  const prompts = [
    ...script.plants.map((plant) => ({ phase: `plant-${plant.stage}`, text: plant.text })),
    ...script.ordinary.map((text, index) => ({ phase: `ordinary-${index + 1}`, text })),
    { phase: 'blind-recall', text: script.recall },
  ]
  const matches = prompts.flatMap(({ phase, text }) => [...text.matchAll(new RegExp(FORBIDDEN_NATURAL_PROMPT, 'giu'))]
    .map((match) => ({ phase, match: match[0] })))
  if (matches.length > 0) throw new Error(`N/G prompt contamination: ${JSON.stringify(matches)}`)
  return {
    forbiddenPattern: String(FORBIDDEN_NATURAL_PROMPT),
    forbiddenMatches: matches,
    prompts: prompts.map(({ phase, text }) => ({ phase, chars: text.length, sha256: hash(text) })),
  }
}

async function waitIdle(client, sessionId) {
  let sawRunning = false
  for (let poll = 0; poll < 300; poll += 1) {
    await sleep(1000)
    const list = await client.call('session.list', {})
    const session = list.items.find((item) => item.sessionId === sessionId)
    if (session?.running === true) sawRunning = true
    else if (sawRunning || poll >= 6) return
  }
  throw new Error(`session ${sessionId} did not settle`)
}

async function history(client, sessionId) {
  return client.call('session.history', { sessionId, maxMessages: 100000 })
}

function callsFrom(events) {
  return events.filter((event) => event.type === 'assistant/message' && event.data?.usage).map((event) => ({
    seq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    prevSeq: Math.max(0, event.seq - 1),
    usage: {
      uncachedInputTokens: event.data.usage.uncachedInputTokens ?? event.data.usage.inputTokens ?? 0,
      cacheReadTokens: event.data.usage.cacheReadTokens ?? 0,
      outputTokens: event.data.usage.outputTokens ?? 0,
    },
  }))
}

function parseArguments(value) {
  let parsed = value
  for (let pass = 0; pass < 3 && typeof parsed === 'string'; pass += 1) {
    try { parsed = JSON.parse(parsed) } catch { return null }
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.arguments === 'string') return parseArguments(parsed.arguments)
  return parsed && typeof parsed === 'object' ? parsed : null
}

function driverUserRanges(events) {
  const users = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
  return users.map((event, index) => ({
    ordinal: index + 1,
    startSeq: event.seq,
    endSeq: users[index + 1]?.seq - 1 ?? Number.MAX_SAFE_INTEGER,
  }))
}

function requestedPosition(range, surfaceRanges) {
  if (!Number.isFinite(range?.startSeq)) return 'unknown'
  const ordinal = surfaceRanges.find((surface) => range.startSeq >= surface.startSeq && range.startSeq <= surface.endSeq)?.ordinal
  if (ordinal === undefined) return 'unknown'
  const count = surfaceRanges.length
  if (ordinal <= Math.ceil(count / 3)) return 'head'
  if (ordinal > Math.floor((count * 2) / 3)) return 'newest'
  return 'middle'
}

function compactionToolCalls(events) {
  const surfaceRanges = driverUserRanges(events)
  return events.filter((event) => event.type === 'tool/call' && event.data?.name === 'compress').map((event) => {
    const parsed = parseArguments(event.data.arguments)
    const content = Array.isArray(parsed?.content) ? parsed.content : []
    const ranges = content.map((entry) => ({
      startSeq: Number(entry?.startSeq),
      endSeq: Number(entry?.endSeq),
      position: requestedPosition(entry, surfaceRanges),
    }))
    return {
      seq: event.seq,
      turn: event.data.turn ?? null,
      step: event.data.step ?? null,
      rangeCount: ranges.length,
      ranges,
      argumentsParseable: parsed !== null,
    }
  })
}

function nudgeEvents(events, totalTurns) {
  return events.filter((event) => event.type === 'user/message' && event.data?.source?.plugin === 'arc-nudge').map((event) => {
    const nextCall = events.find((candidate) => candidate.seq > event.seq && candidate.type === 'assistant/message' && candidate.data?.usage)
    const text = textOf(event.data?.content)
    const turn = nextCall?.data?.turn ?? null
    const tier = /compress now/i.test(text) ? 'emergency' : 'normal'
    return {
      seq: event.seq,
      tier,
      turn,
      textSha256: hash(text),
      displayedPct: Number(/ARC\s+(\d+)%/i.exec(text)?.[1] ?? NaN) || null,
      tableRanges: [...text.matchAll(/seqs?\s+(\d+)\.\.(\d+)/gi)].map((match) => ({ startSeq: Number(match[1]), endSeq: Number(match[2]) })),
      eligibleForThreeTurns: turn !== null && turn + 2 <= totalTurns,
    }
  })
}

function summaryEvents(events) {
  return events.filter((event) => event.type === 'compaction/summary').map((event) => ({
    seq: event.seq,
    compactionId: event.data?.compactionId ?? null,
    shadowedRange: event.data?.shadowedRange ?? null,
    shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
    provider: event.data?.provider ?? null,
    model: event.data?.model ?? null,
    tier: event.data?.tier ?? null,
    mode: event.data?.provider === 'local' || /adaptive-governor/i.test(String(event.data?.model ?? '')) ? 'governor-local' : 'model',
  }))
}

function queryCorpus(events, queryTurn) {
  const answers = []
  const tools = []
  for (const event of events) {
    if ((event.data?.turn ?? -1) !== queryTurn) continue
    if (event.type === 'assistant/message') answers.push(textOf(event.data?.message?.content))
    if (event.type === 'tool/result') tools.push(textOf(event.data?.message?.content))
  }
  return { answer: answers.join('\n'), tool: tools.join('\n') }
}

function state(events, queryTurn) {
  const calls = callsFrom(events)
  const toolCalls = compactionToolCalls(events)
  const summaries = summaryEvents(events)
  const nudges = nudgeEvents(events, queryTurn)
  const compactionEnds = events.filter((event) => event.type === 'compaction/end').map((event) => ({ afterSeq: event.seq }))
  const ledger = buildLedger(calls, compactionEnds)
  return { calls, toolCalls, summaries, nudges, ledger }
}

function compressInstruction(ranges) {
  const list = ranges.map((range) => `{ startSeq: ${range.startSeq}, endSeq: ${range.endSeq}, summary: <write a faithful record summary> }`).join(', ')
  return `Call the compress tool once with content:\n[${list}]\nWrite the record summaries yourself, then reply DONE.`
}

async function live() {
  if (!ARMS.includes(ARM)) throw new Error(`RQ5_ARM must be one of ${ARMS.join(', ')}`)
  const natural = NATURAL_ARMS.has(ARM)
  const script = safeScript(SEED)
  const promptAudit = natural ? assertNaturalPromptAudit(script) : {
    forbiddenPattern: String(FORBIDDEN_NATURAL_PROMPT),
    forbiddenMatches: null,
    prompts: [],
    note: 'P is the intentional proactive-compression comparison and is exempt from the N/G natural-prompt constraint.',
  }
  const client = makeClient(URL)
  mkdirSync(CWD, { recursive: true })
  const priorState = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null
  const requestedSessionId = process.env.RQ5_SESSION_ID ?? priorState?.sessionId
  let sessionId
  let agentPreset
  if (requestedSessionId) {
    sessionId = requestedSessionId
    agentPreset = priorState?.agentPreset ?? null
  } else {
    const created = await client.call('session.create', { cwd: CWD })
    sessionId = created.sessionId
    agentPreset = created.agentPreset
    await client.call('session.selectModel', { sessionId, provider: 'scnet', model: 'GLM-5.2', reasoningEffort: 'max' })
  }
  const trace = priorState?.trace ?? []

  async function send(phase, text) {
    let before = await history(client, sessionId)
    let beforeCalls = callsFrom(before.events.map(eventOf)).length
    if (beforeCalls >= PER_ARM_BUDGET) throw new Error(`per-arm call budget reached before ${phase}: ${beforeCalls}/${PER_ARM_BUDGET}`)
    await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
    await waitIdle(client, sessionId)
    const after = await history(client, sessionId)
    const events = after.events.map(eventOf)
    const calls = callsFrom(events)
    const pressure = after.projections?.values?.contextPressure ?? {}
    trace.push({
      phase,
      promptChars: text.length,
      promptSha256: hash(text),
      modelCalls: calls.length,
      callsAdded: calls.length - beforeCalls,
      projectedTokens: pressure.projectedTokens ?? null,
      contextWindow: pressure.contextWindow ?? null,
      lastCall: calls.at(-1)?.usage ?? null,
    })
    return { after, events, calls, pressure }
  }

  const initial = await history(client, sessionId)
  let current = { events: initial.events.map(eventOf), pressure: initial.projections?.values?.contextPressure ?? {} }
  const target = natural ? Math.floor(WINDOW * 0.77) : Math.floor(WINDOW * 0.40)
  const planned = natural
    ? [
        ...script.plants.slice(0, 4).map((plant) => ({ phase: `plant-${plant.stage}`, text: plant.text })),
        ...script.ordinary.map((text, index) => ({ phase: `ordinary-${index + 1}`, text })),
        { phase: 'blind-recall', text: script.recall },
      ]
    : [
        { phase: 'proactive-plant', text: script.proactivePlant },
        { phase: 'proactive-compress', text: () => compressInstruction(driverUserRanges(current.events).slice(0, 1)) },
        { phase: 'settle', text: 'Reply exactly: SETTLED' },
        { phase: 'blind-recall', text: script.recall },
      ]
  let promptIndex = driverUserRanges(current.events).length
  let promptsThisInvocation = 0
  while (promptIndex < planned.length && promptsThisInvocation < MAX_NEW_PROMPTS) {
    const next = planned[promptIndex]
    current = await send(next.phase, typeof next.text === 'function' ? next.text() : next.text)
    promptIndex += 1
    promptsThisInvocation += 1
  }
  const statePayload = { schemaVersion: 1, arm: ARM, sessionId, agentPreset, trace, promptsCompleted: promptIndex, plannedPrompts: planned.length }
  writeFileSync(STATE_FILE, JSON.stringify(statePayload, null, 2) + '\n')
  const incomplete = promptIndex < planned.length
  if (incomplete && !FINALIZE_PARTIAL) {
    console.log(JSON.stringify({ arm: ARM, partial: true, sessionId, stateFile: STATE_FILE, promptsCompleted: promptIndex, plannedPrompts: planned.length }, null, 2))
    return
  }
  const plantsSent = natural ? 4 : 1

  const events = current.events
  const queryTurn = incomplete ? null : callsFrom(events).at(-1)?.turn
  if (queryTurn === undefined) throw new Error('blind-recall produced no model call')
  const measured = state(events, queryTurn)
  const corpus = queryTurn === null ? null : queryCorpus(events, queryTurn)
  const answerOnly = corpus === null ? null : scoreRecall(script.facts, corpus.answer, {}, { answerText: corpus.answer, toolText: corpus.tool })
  const benchCorpus = corpus === null ? null : scoreRecall(script.facts, `${corpus.answer}\n${corpus.tool}`, {}, { answerText: corpus.answer, toolText: corpus.tool })

  const annotatedNudges = measured.nudges.map((nudge) => {
    const match = nudge.turn === null ? undefined : measured.toolCalls.find((call) => call.turn !== null && call.turn >= nudge.turn && call.turn <= nudge.turn + 2)
    return {
      ...nudge,
      firstCompressSeqWithinWindow: match?.seq ?? null,
      latencyTurns: match === undefined || nudge.turn === null || match.turn === null ? null : match.turn - nudge.turn,
      compliedWithinThreeTurns: Boolean(match),
    }
  })
  const localArchives = measured.summaries.filter((summary) => summary.mode === 'governor-local')
  const modelSummaries = measured.summaries.filter((summary) => summary.mode === 'model')
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    arm: ARM,
    sessionId,
    agentPreset,
    setup: {
      host: 'isolated DSH_HOME web profile; fresh process per arm',
      model: 'scnet/GLM-5.2',
      configuredWindow: WINDOW,
      cleanCwd: CWD,
      seed: SEED,
      noiseLines: NOISE_LINES,
      targetProjectedTokens: target,
      perArmBudget: PER_ARM_BUDGET,
      expectedPatch: `research/profiles/rq5-${ARM.toLowerCase()}.patch.yml`,
      appliedPatchSha256: process.env.RQ5_PATCH_SHA ?? null,
    },
    promptAudit,
    trace,
    completion: incomplete
      ? { status: 'partial', promptsCompleted: promptIndex, plannedPrompts: planned.length, reason: 'live-call budget halted before a successful P proactive compression and blind-recall query' }
      : { status: 'complete', promptsCompleted: promptIndex, plannedPrompts: planned.length },
    plantsSent,
    queryTurn,
    facts: { scorable: script.facts.length, factIds: script.facts.map((fact) => fact.id) },
    nudges: annotatedNudges,
    compressToolCalls: measured.toolCalls,
    compactions: measured.summaries,
    governor: {
      localArchiveCount: localArchives.length,
      localArchives,
      modelSummaryCount: modelSummaries.length,
    },
    quality: {
      ...(answerOnly === null || benchCorpus === null
        ? { available: false, reason: 'No blind-recall answer exists in this partial session.' }
        : {
            available: true,
            answerOnly: { strict: answerOnly.score, loose: answerOnly.scoreLoose, strictRate: answerOnly.recallRate, looseRate: answerOnly.recallRateLoose, unknownLines: answerOnly.unknownLines },
            benchAnswerPlusTool: { strict: benchCorpus.score, loose: benchCorpus.scoreLoose, strictRate: benchCorpus.recallRate, looseRate: benchCorpus.recallRateLoose },
            queryToolCalls: events.filter((event) => event.type === 'tool/call' && event.data?.turn === queryTurn).map((event) => event.data?.name),
          }),
    },
    costLedger: measured.ledger.totals,
    perCall: measured.ledger.series,
    rawEvidence: {
      durableLog: `isolated host session ${sessionId} (not copied into repository)`,
      nudgeSource: 'user/message where source.plugin === arc-nudge',
      compressionSource: 'tool/call name === compress; arguments parsed offline',
    },
  }
  mkdirSync(BENCH_RESULTS, { recursive: true })
  const out = resolve(BENCH_RESULTS, `rq5-${ARM.toLowerCase()}.json`)
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ arm: ARM, file: out, calls: measured.calls.length, nudges: annotatedNudges.length, modelCompressions: modelSummaries.length, localArchives: localArchives.length, quality: result.quality.answerOnly ?? result.quality.reason, completion: result.completion.status }, null, 2))
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function rate(records) {
  const eligible = records.filter((record) => record.eligibleForThreeTurns)
  const complied = eligible.filter((record) => record.compliedWithinThreeTurns)
  return { eligible: eligible.length, complied: complied.length, rate: eligible.length === 0 ? null : complied.length / eligible.length }
}

function histogram(values) {
  const buckets = {}
  for (const value of values) buckets[value] = (buckets[value] ?? 0) + 1
  return buckets
}

function median(values) {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

function consolidate() {
  const reports = {}
  for (const arm of ARMS) {
    const file = resolve(BENCH_RESULTS, `rq5-${arm.toLowerCase()}.json`)
    if (!existsSync(file)) throw new Error(`missing live arm report: ${file}`)
    reports[arm] = JSON.parse(readFileSync(file, 'utf8'))
  }
  const nudgeRecords = ['N', 'G80', 'G88'].flatMap((arm) => reports[arm].nudges.map((nudge) => ({ arm, ...nudge })))
  const normal = rate(nudgeRecords.filter((record) => record.tier === 'normal'))
  const emergency = rate(nudgeRecords.filter((record) => record.tier === 'emergency'))
  const latencyValues = nudgeRecords.filter((record) => record.eligibleForThreeTurns && record.latencyTurns !== null).map((record) => record.latencyTurns)
  const pressuredModelQuality = ['N', 'G80', 'G88']
    .filter((arm) => reports[arm].governor.modelSummaryCount > 0 && reports[arm].quality.available !== false)
    .map((arm) => ({ arm, strictRate: reports[arm].quality.answerOnly.strictRate, looseRate: reports[arm].quality.answerOnly.looseRate }))
  const allPressuredQuality = ['N', 'G80', 'G88'].filter((arm) => reports[arm].quality.available !== false)
    .map((arm) => ({ arm, strictRate: reports[arm].quality.answerOnly.strictRate, looseRate: reports[arm].quality.answerOnly.looseRate }))
  const pQuality = reports.P.quality.answerOnly ?? null
  const spontaneousCalls = ['N', 'G80', 'G88'].flatMap((arm) => reports[arm].compressToolCalls.map((call) => ({ arm, ...call })))
  const rangeCounts = spontaneousCalls.map((call) => call.rangeCount)
  const positions = spontaneousCalls.flatMap((call) => call.ranges.map((range) => range.position))
  const batchCalls = spontaneousCalls.filter((call) => call.rangeCount >= 2).length
  const partialCalls = spontaneousCalls.filter((call) => call.rangeCount === 1).length
  const headPositions = positions.filter((position) => position === 'head').length
  const totalCalls = ARMS.reduce((sum, arm) => sum + reports[arm].perCall.length, 0)
  const pressureStrict = mean(pressuredModelQuality.map((quality) => quality.strictRate))
  const pressureLoose = mean(pressuredModelQuality.map((quality) => quality.looseRate))
  const decisionTwo = spontaneousCalls.length < 3
    ? { verdict: 'underdetermined-low-n', recommendation: 'Fewer than three spontaneous model compress calls were observed; retain the existing oldest-first table and collect another RQ5 sample before changing range ordering.' }
    : batchCalls > spontaneousCalls.length / 2
      ? { verdict: 'batch-dominant', recommendation: 'Model behavior is batch-dominant; newest-safe ordering is not justified by this sample. Keep the current table/footnote state.' }
      : partialCalls > spontaneousCalls.length / 2 && headPositions / Math.max(1, positions.length) >= 0.6
        ? { verdict: 'partial-head-dominant', recommendation: 'Partial calls concentrate at the table head; this supports the measured cache-loss concern. Propose a separately reviewed newest-safe ordering experiment.' }
        : { verdict: 'mixed', recommendation: 'No dominant batch or head-partial behavior; retain current ordering pending more RQ5 samples.' }
  const normalHigh = normal.rate !== null && normal.rate >= 0.8
  const qualityNotWorse = pressureStrict === null || pQuality === null || pQuality.strictRate === null
    ? null
    : pressureStrict >= pQuality.strictRate
  const verdict = normalHigh && qualityNotWorse
    ? 'normal-line passes the stated ladder-stability criterion'
    : 'normal-line criterion not established; use G80/G88 outcome as evidence only and do not change defaults in this measurement task'
  const final = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    question: 'RQ5: nudge compliance, latency, pressured-summary quality, Governor timing, and RQ2 decision-two behavior.',
    methodology: {
      arms: {
        N: { patch: 'research/profiles/rq5-n.patch.yml', mode: 'natural advisory nudge; Governor off' },
        G80: { patch: 'research/profiles/rq5-g80.patch.yml', mode: 'Governor on; 75% normal / 80% fallback over 28,672-token effective capacity' },
        G88: { patch: 'research/profiles/rq5-g88.patch.yml', mode: 'Governor on; 75% normal / 88% fallback over 28,672-token effective capacity' },
        P: { patch: 'research/profiles/rq5-p.patch.yml', mode: 'automatic nudge off; instructed low-pressure proactive compression' },
      },
      complianceDefinition: 'An eligible arc-nudge is compliant when a model compress tool call appears in its current response or either of the next two model turns.',
      contaminationGuard: 'N/G prompt text is SHA-256 recorded and mechanically rejected if it contains compress/compression/context/nudge/summary variants or 压缩/上下文/提示.',
      rawEvidence: 'Metrics are derived offline from the durable session history; no nudge-observation prompt or extra model call is issued.',
    },
    arms: Object.fromEntries(ARMS.map((arm) => [arm, {
      sessionId: reports[arm].sessionId,
      setup: reports[arm].setup,
      promptAudit: reports[arm].promptAudit,
      calls: reports[arm].perCall.length,
      nudgeCount: reports[arm].nudges.length,
      compactionCount: reports[arm].compactions.length,
      localArchiveCount: reports[arm].governor.localArchiveCount,
      quality: reports[arm].quality,
      costLedger: reports[arm].costLedger,
      report: `results/bench/rq5-${arm.toLowerCase()}.json`,
    }])),
    compliance: {
      normal: { ...normal, records: nudgeRecords.filter((record) => record.tier === 'normal') },
      emergency: { ...emergency, records: nudgeRecords.filter((record) => record.tier === 'emergency') },
    },
    latency: { samples: latencyValues, distribution: histogram(latencyValues), medianTurns: median(latencyValues) },
    quality: {
      scorer: 'RQ1 bench scorer form-contract v2; strict answer-only plus loose information-level and answer+tool duals.',
      pressuredModelSummaries: { sampleArms: pressuredModelQuality, meanStrictRate: pressureStrict, meanLooseRate: pressureLoose },
      allNudgeGovernorArms: allPressuredQuality,
      proactiveP: pQuality,
      comparison: pressureStrict === null || pQuality === null ? 'Model-summary quality versus P is not estimable from this sample.' : {
        strictDeltaVsP: pressureStrict - pQuality.strictRate,
        looseDeltaVsP: pressureLoose - pQuality.looseRate,
        pressureNotWorseThanP: qualityNotWorse,
      },
    },
    decisionTwo: {
      unit: 'model compress tool call in N/G only; Governor-local blocks and P-instructed calls excluded',
      totalSpontaneousCalls: spontaneousCalls.length,
      rangeCounts,
      batchCalls,
      partialCalls,
      positions: histogram(positions),
      calls: spontaneousCalls,
      ...decisionTwo,
    },
    governorComparison: Object.fromEntries(['G80', 'G88'].map((arm) => [arm, {
      earlyArchiveTriggerCount: reports[arm].governor.localArchiveCount,
      firstLocalArchive: reports[arm].governor.localArchives[0] ?? null,
      modelSummaryCount: reports[arm].governor.modelSummaryCount,
      quality: reports[arm].quality.answerOnly ?? { unavailable: reports[arm].quality.reason ?? 'not measured' },
      cost: reports[arm].costLedger,
    }])),
    costLedger: {
      threeFields: ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens'],
      selectedArmModelCalls: totalCalls,
      totalModelCalls: Number(process.env.RQ5_ACTUAL_TOTAL_CALLS ?? totalCalls),
      cap: GLOBAL_BUDGET,
      withinBudget: Number(process.env.RQ5_ACTUAL_TOTAL_CALLS ?? totalCalls) <= GLOBAL_BUDGET,
      discardedSetupOrIncompleteCalls: Number(process.env.RQ5_ACTUAL_TOTAL_CALLS ?? totalCalls) - totalCalls,
      totals: ARMS.reduce((total, arm) => {
        for (const field of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens']) total[field] += reports[arm].costLedger[field]
        return total
      }, { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }),
    },
    completion: reports.P.completion.status === 'complete'
      ? { status: 'complete' }
      : { status: 'partial', reason: reports.P.completion.reason },
    criteria: { normalLineAtLeast80Pct: normalHigh, pressuredQualityNotWorseThanP: qualityNotWorse, verdict },
    verification: {
      allFourArmsPresent: ARMS.every((arm) => reports[arm].arm === arm),
      naturalPromptAuditClean: ['N', 'G80', 'G88'].every((arm) => reports[arm].promptAudit.forbiddenMatches.length === 0),
      budgetWithinLimit: Number(process.env.RQ5_ACTUAL_TOTAL_CALLS ?? totalCalls) <= GLOBAL_BUDGET,
      qualityDualRecordedOrExplicitlyUnavailable: ARMS.every((arm) => reports[arm].quality.available === false || (reports[arm].quality.answerOnly.strict !== undefined && reports[arm].quality.benchAnswerPlusTool.loose !== undefined)),
    },
  }
  final.costLedger.totals.totalPromptTokens = final.costLedger.totals.uncachedInputTokens + final.costLedger.totals.cacheReadTokens
  mkdirSync(RESULTS, { recursive: true })
  writeFileSync(FINAL, JSON.stringify(final, null, 2) + '\n')
  console.log(JSON.stringify({ file: FINAL, calls: totalCalls, normal, emergency, latency: final.latency, decisionTwo: final.decisionTwo.verdict, criteria: final.criteria }, null, 2))
  if (!final.verification.budgetWithinLimit || !final.verification.naturalPromptAuditClean) process.exitCode = 1
}

const mode = process.argv[2] ?? 'live'
if (mode === 'consolidate') consolidate()
else if (mode === 'audit') {
  const script = safeScript(SEED)
  console.log(JSON.stringify(assertNaturalPromptAudit(script), null, 2))
}
else if (mode === 'live') {
  try {
    await live()
  } catch (error) {
    console.error(`FAILED: ${error.message}`)
    process.exitCode = 1
  }
}
else throw new Error('usage: rq5-compliance.mjs [live|consolidate|audit]')
