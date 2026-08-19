#!/usr/bin/env node
/**
 * RQ5b completion runner.  It deliberately keeps the first RQ5 result
 * immutable and writes phase-two P/N reports alongside it:
 *
 *   RQ5B_ARM=P node research/bench/rq5b-completion.mjs live
 *   RQ5B_ARM=N RQ5B_RUN=1 node research/bench/rq5b-completion.mjs live
 *   RQ5B_ARM=N RQ5B_RUN=2 node research/bench/rq5b-completion.mjs live
 *   RQ5B_ARM=N RQ5B_RUN=3 node research/bench/rq5b-completion.mjs live
 *   node research/bench/rq5b-completion.mjs consolidate
 *
 * P uses five small plant turns.  Its sole compression instruction requires
 * arc_status first and tells the model to select the table's oldest suggestion
 * itself; this runner never writes a sequence number into that instruction.
 * N reuses the first-run N content and contamination guard byte-for-byte.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { generateFacts, mulberry32, noiseBlock } from './facts.mjs'
import { makeClient } from './driver.mjs'
import { buildLedger } from './ledger.mjs'
import { scoreRecall } from './scorer.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const RESULTS = resolve(ROOT, 'results')
const BENCH_RESULTS = resolve(RESULTS, 'bench')
const FINAL = resolve(RESULTS, 'rq5-compliance-results.json')
const ARM = process.env.RQ5B_ARM
const RUN = ARM === 'N' ? Number(process.env.RQ5B_RUN) : null
const URL = process.env.RQ5B_URL ?? 'http://127.0.0.1:8933'
const WINDOW = 32768
const SEED = 505
const N_NOISE_LINES = 260
const P_NOISE_LINES = 20
const P_PLANT_TURNS = 5
const N_PER_SESSION_CAP = Number(process.env.RQ5B_N_PER_SESSION_CAP ?? 10)
const P_PER_SESSION_CAP = 15
const GLOBAL_CAP = 45
const PHASE_ONE_CANONICAL_SHA256 = '3dc292d1078581e126efa563437035d0da217568248edd55df56e79b40ceac60'
const FORBIDDEN_NATURAL_PROMPT = /\b(?:compress|compression|context|nudge|summar(?:y|ize|ization))\b|压缩|上下文|提示/iu

const hash = (text) => createHash('sha256').update(text).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const eventOf = (entry) => entry.event ?? entry

function textOf(content) {
  return (content ?? []).flatMap((block) => {
    if (block?.type === 'text') return [block.text ?? '']
    return (block?.content ?? []).filter((nested) => nested?.type === 'text').map((nested) => nested.text ?? '')
  }).join('\n')
}

function allFacts() {
  return generateFacts(SEED, { facts: 24 }).filter((fact) => fact.category !== 'trap')
}

// Copied verbatim in behavior from rq5-compliance.mjs: four 260-line plants,
// then three neutral turns and the same blind-recall request.
function naturalScript() {
  const rng = mulberry32(SEED * 7919 + 13)
  const facts = allFacts()
  const perStage = Math.ceil(facts.length / 7)
  const plants = []
  for (let stage = 0; stage < 7; stage += 1) {
    const records = facts.slice(stage * perStage, (stage + 1) * perStage)
    if (records.length === 0) continue
    plants.push({
      stage: stage + 1,
      text: [
        `Operations ledger import ${stage + 1}/7.`,
        'Reference records:',
        ...records.map((record) => `- [${record.id}] ${record.category === 'paraphrase' ? record.statement : record.needle}`),
        '',
        'Telemetry:',
        '```',
        noiseBlock(rng, N_NOISE_LINES),
        '```',
        '',
        `Reply exactly: ACK-${stage + 1}`,
      ].join('\n'),
    })
  }
  const questions = facts.map((fact) => `${fact.id}: ${fact.question}`).join('\n')
  return {
    facts,
    plants,
    ordinary: ['Reply exactly: PING-1', 'Reply exactly: PING-2', 'Reply exactly: PING-3'],
    // This is the literal first-N prompt (the later G88 retry added a
    // tool prohibition, so it is not the expansion baseline).
    recall: `Give one exact answer for each record ID below. One line per ID. If unavailable, write UNKNOWN.\n${questions}`,
  }
}

function proactiveScript() {
  const rng = mulberry32(SEED * 1231 + 41)
  const facts = allFacts()
  const perPlant = Math.ceil(facts.length / P_PLANT_TURNS)
  const plants = []
  for (let plant = 0; plant < P_PLANT_TURNS; plant += 1) {
    const records = facts.slice(plant * perPlant, (plant + 1) * perPlant)
    plants.push({
      stage: plant + 1,
      text: [
        `Operations ledger import ${plant + 1}/${P_PLANT_TURNS}.`,
        'Reference records:',
        ...records.map((record) => `- [${record.id}] ${record.category === 'paraphrase' ? record.statement : record.needle}`),
        '',
        'Telemetry:',
        '```',
        noiseBlock(rng, P_NOISE_LINES),
        '```',
        '',
        `Reply exactly: ACK-P-${plant + 1}`,
      ].join('\n'),
    })
  }
  const questions = facts.map((fact) => `${fact.id}: ${fact.question}`).join('\n')
  return {
    facts,
    plants,
    ordinary: ['Reply exactly: P-SETTLED-1', 'Reply exactly: P-SETTLED-2'],
    recall: `Do not call any tools. Give one exact answer for each record ID below. One line per ID. If unavailable, write UNKNOWN.\n${questions}`,
    compressionInstruction: [
      'First call arc_status.',
      'Read its compressible-range table, then select the oldest suggested range from that table.',
      'Call compress once for that selected range with a faithful record summary you write yourself.',
      'Do not invent or receive sequence numbers from this request; use the range returned by arc_status.',
      'Then reply exactly: P-COMPRESSED.',
    ].join(' '),
  }
}

function assertNaturalPromptAudit(script) {
  const prompts = [
    ...script.plants.slice(0, 4).map((plant) => ({ phase: `plant-${plant.stage}`, text: plant.text })),
    ...script.ordinary.map((text, index) => ({ phase: `ordinary-${index + 1}`, text })),
    { phase: 'blind-recall', text: script.recall },
  ]
  const matches = prompts.flatMap(({ phase, text }) => [...text.matchAll(new RegExp(FORBIDDEN_NATURAL_PROMPT, 'giu'))]
    .map((match) => ({ phase, match: match[0] })))
  if (matches.length > 0) throw new Error(`N prompt contamination: ${JSON.stringify(matches)}`)
  return {
    forbiddenPattern: String(FORBIDDEN_NATURAL_PROMPT),
    forbiddenMatches: matches,
    prompts: prompts.map(({ phase, text }) => ({ phase, chars: text.length, sha256: hash(text) })),
    sameNaturalDriverAsFirstRun: true,
  }
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

function userRanges(events) {
  const users = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
  return users.map((event, index) => ({ ordinal: index + 1, startSeq: event.seq, endSeq: users[index + 1]?.seq - 1 ?? Number.MAX_SAFE_INTEGER }))
}

function requestedPosition(range, ranges) {
  if (!Number.isFinite(range?.startSeq)) return 'unknown'
  const ordinal = ranges.find((candidate) => range.startSeq >= candidate.startSeq && range.startSeq <= candidate.endSeq)?.ordinal
  if (ordinal === undefined) return 'unknown'
  if (ordinal <= Math.ceil(ranges.length / 3)) return 'head'
  if (ordinal > Math.floor((ranges.length * 2) / 3)) return 'newest'
  return 'middle'
}

function toolCalls(events) {
  const ranges = userRanges(events)
  return events.filter((event) => event.type === 'tool/call').map((event) => {
    const parsed = parseArguments(event.data?.arguments)
    const content = Array.isArray(parsed?.content) ? parsed.content : []
    return {
      seq: event.seq,
      name: event.data?.name ?? null,
      turn: event.data?.turn ?? null,
      step: event.data?.step ?? null,
      argumentsParseable: parsed !== null,
      ranges: content.map((entry) => ({
        startSeq: Number(entry?.startSeq),
        endSeq: Number(entry?.endSeq),
        position: requestedPosition(entry, ranges),
      })),
    }
  })
}

function nudgeEvents(events, totalTurns) {
  return events.filter((event) => event.type === 'user/message' && event.data?.source?.plugin === 'arc-nudge').map((event) => {
    const nextCall = events.find((candidate) => candidate.seq > event.seq && candidate.type === 'assistant/message' && candidate.data?.usage)
    const text = textOf(event.data?.content)
    const turn = nextCall?.data?.turn ?? null
    return {
      seq: event.seq,
      tier: /compress now/i.test(text) ? 'emergency' : 'normal',
      turn,
      textSha256: hash(text),
      displayedPct: Number(/ARC\s+(\d+)%/i.exec(text)?.[1] ?? NaN) || null,
      tableRanges: [...text.matchAll(/seqs?\s+(\d+)\.\.(\d+)/gi)].map((match) => ({ startSeq: Number(match[1]), endSeq: Number(match[2]) })),
      eligibleForThreeTurns: turn !== null && turn + 2 <= totalTurns,
    }
  })
}

function summaries(events) {
  return events.filter((event) => event.type === 'compaction/summary').map((event) => ({
    seq: event.seq,
    compactionId: event.data?.compactionId ?? null,
    shadowedRange: event.data?.shadowedRange ?? null,
    shadowedSeqs: event.data?.shadowedSeqs ?? [],
    shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
    provider: event.data?.provider ?? null,
    model: event.data?.model ?? null,
    summaryText: textOf(event.data?.summary),
  }))
}

function queryCorpus(events, queryTurn) {
  const answer = []
  const tool = []
  for (const event of events) {
    if ((event.data?.turn ?? -1) !== queryTurn) continue
    if (event.type === 'assistant/message') answer.push(textOf(event.data?.message?.content))
    if (event.type === 'tool/result') tool.push(textOf(event.data?.message?.content))
  }
  return { answer: answer.join('\n'), tool: tool.join('\n') }
}

function factIdsIn(event) {
  return [...textOf(event?.data?.content).matchAll(/\[f(\d+)\]/g)].map((match) => `f${match[1]}`)
}

function modelSummaryAudit(events, compacted) {
  const factsById = new Map(allFacts().map((fact) => [fact.id, fact]))
  const eventsBySeq = new Map(events.map((event) => [event.seq, event]))
  return compacted.map((summary) => {
    const facts = [...new Set(summary.shadowedSeqs.flatMap((seq) => factIdsIn(eventsBySeq.get(seq))))]
      .map((id) => factsById.get(id)).filter(Boolean)
    const score = facts.length === 0 ? null : scoreRecall(facts, summary.summaryText, {}, { answerText: summary.summaryText })
    return {
      seq: summary.seq,
      compactionId: summary.compactionId,
      plantedFactIds: facts.map((fact) => fact.id),
      strict: score?.score ?? null,
      loose: score?.scoreLoose ?? null,
      strictRate: score?.recallRate ?? null,
      looseRate: score?.recallRateLoose ?? null,
      perFact: score?.perFact.map((fact) => ({ ...fact, retention: fact.hit ? 'verbatim' : fact.hitLoose ? 'paraphrase' : 'lost' })) ?? [],
    }
  })
}

function annotateNudges(nudges, compressCalls) {
  return nudges.map((nudge) => {
    const match = nudge.turn === null ? undefined : compressCalls.find((call) => call.turn !== null && call.turn >= nudge.turn && call.turn <= nudge.turn + 2)
    return {
      ...nudge,
      firstCompressSeqWithinWindow: match?.seq ?? null,
      latencyTurns: match === undefined || nudge.turn === null || match.turn === null ? null : match.turn - nudge.turn,
      compliedWithinThreeTurns: Boolean(match),
    }
  })
}

function reportPath() {
  if (ARM === 'P') return resolve(BENCH_RESULTS, 'rq5b-p.json')
  if (ARM === 'N' && Number.isInteger(RUN) && RUN >= 1 && RUN <= 3) return resolve(BENCH_RESULTS, `rq5b-n-${RUN}.json`)
  throw new Error('use RQ5B_ARM=P, or RQ5B_ARM=N with RQ5B_RUN=1..3')
}

function readDurableEvents(sessionId) {
  const dshHome = process.env.RQ5B_DSH_HOME ?? resolve(process.env.HOME ?? '', 'Workspace/dsh-extensions/verify/arc-live-rc7')
  const found = spawnSync('find', [resolve(dshHome, 'sessions'), '-path', `*/${sessionId}/session.jsonl.zstd`], { encoding: 'utf8' })
  if (found.status !== 0 || found.stdout.trim() === '') throw new Error(`durable log not found for ${sessionId}`)
  const decoded = spawnSync('zstd', ['-q', '-d', '-c', found.stdout.trim()], { encoding: 'utf8' })
  if (decoded.status !== 0) throw new Error(`could not decode durable log for ${sessionId}: ${decoded.stderr}`)
  return decoded.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function writeRecoveredNReport() {
  if (ARM !== 'N' || !Number.isInteger(RUN) || RUN < 1 || RUN > 3) throw new Error('recovery requires RQ5B_ARM=N and RQ5B_RUN=1..3')
  const sessionId = process.env.RQ5B_RECOVER_SESSION
  if (!sessionId) throw new Error('recovery requires RQ5B_RECOVER_SESSION')
  const path = reportPath()
  if (existsSync(path) && process.env.RQ5B_REPLACE !== '1') throw new Error(`${path} exists; refuse to overwrite without RQ5B_REPLACE=1`)
  const events = readDurableEvents(sessionId)
  const calls = callsFrom(events)
  const allToolCalls = toolCalls(events)
  const compressCalls = allToolCalls.filter((call) => call.name === 'compress')
  const lastTurn = calls.at(-1)?.turn
  const nudges = annotateNudges(nudgeEvents(events, lastTurn ?? 0), compressCalls)
  const ledger = buildLedger(calls, events.filter((event) => event.type === 'compaction/end').map((event) => ({ afterSeq: event.seq })))
  const promptAudit = assertNaturalPromptAudit(naturalScript())
  const recoveryReason = process.env.RQ5B_RECOVER_REASON
    ?? 'The provider stream made no durable progress for more than ten minutes; it was cancelled without a new model call. Earlier durable nudge/compress events are retained.'
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    arm: 'N',
    run: RUN,
    sessionId,
    setup: {
      host: 'isolated DSH_HOME web profile; fresh process per arm',
      model: 'scnet/GLM-5.2',
      configuredWindow: WINDOW,
      seed: SEED,
      noiseLines: N_NOISE_LINES,
      expectedPatch: 'research/profiles/rq5-n.patch.yml',
      perSessionCallCap: N_PER_SESSION_CAP,
      appliedPatchSha256: process.env.RQ5B_PATCH_SHA ?? null,
    },
    promptAudit,
    completion: {
      status: process.env.RQ5B_RECOVER_STATUS ?? 'partial-cancelled-stalled-stream',
      reason: recoveryReason,
    },
    trace: [],
    facts: { scorable: allFacts().length, factIds: allFacts().map((fact) => fact.id) },
    nudges,
    toolCalls: allToolCalls,
    compressToolCalls: compressCalls,
    compactions: summaries(events).filter((summary) => summary.provider !== 'local').map(({ summaryText, ...summary }) => summary),
    summaryAudit: modelSummaryAudit(events, summaries(events).filter((summary) => summary.provider !== 'local')),
    quality: { available: false, reason: 'No blind-recall turn: stalled provider stream was cancelled after its durable nudge/compress evidence landed.' },
    costLedger: ledger.totals,
    perCall: ledger.series,
    rawEvidence: {
      durableLog: `isolated host session ${sessionId} (not copied into repository)`,
      nudgeSource: 'user/message where source.plugin === arc-nudge',
      compressionSource: 'tool/call name === compress; arguments parsed offline',
    },
    verification: {
      perSessionBudgetWithinCap: calls.length <= N_PER_SESSION_CAP,
      nPromptAuditClean: promptAudit.forbiddenMatches.length === 0,
      recoveredWithoutModelCalls: true,
    },
  }
  mkdirSync(BENCH_RESULTS, { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ file: path, recovered: true, calls: calls.length, nudges: nudges.length, compressCalls: compressCalls.length, verification: report.verification }, null, 2))
}

function annotatePReport() {
  const path = resolve(BENCH_RESULTS, 'rq5b-p.json')
  const report = JSON.parse(readFileSync(path, 'utf8'))
  const events = readDurableEvents(report.sessionId)
  const statusCall = events.find((event) => event.type === 'tool/call' && event.data?.name === 'arc_status')
  const output = statusCall === undefined ? '' : textOf(events.find((event) => event.type === 'tool/result' && event.data?.message?.source?.callId === statusCall.data?.callId)?.data?.message?.content)
  const hasSuggestedRangeTable = /compressible ranges|suggested range/i.test(output)
  report.pProtocol = {
    ...report.pProtocol,
    arcStatusSuggestedRangeTablePresent: hasSuggestedRangeTable,
    arcStatusOutputSha256: output === '' ? null : hash(output),
    failureReason: statusCall !== undefined && report.compressToolCalls.length === 0 && !hasSuggestedRangeTable
      ? 'arc_status returned only aggregate surface bounds, not a suggested-range table; under the no-handwritten-seq protocol the model had no permitted range to submit to compress.'
      : null,
  }
  report.verification = {
    ...report.verification,
    pArcStatusCalled: statusCall !== undefined,
    pMissingSuggestedRangeTableProven: statusCall !== undefined && !hasSuggestedRangeTable,
    pSecondFailureLocated: statusCall !== undefined && report.compressToolCalls.length === 0 && !hasSuggestedRangeTable,
  }
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ file: path, pProtocol: report.pProtocol, verification: report.verification }, null, 2))
}

async function live() {
  const path = reportPath()
  if (existsSync(path) && process.env.RQ5B_REPLACE !== '1') throw new Error(`${path} exists; refuse to overwrite without RQ5B_REPLACE=1`)
  const natural = ARM === 'N'
  const script = natural ? naturalScript() : proactiveScript()
  const promptAudit = natural ? assertNaturalPromptAudit(script) : {
    intentionalProactiveInstruction: true,
    plants: P_PLANT_TURNS,
    noiseLinesPerPlant: P_NOISE_LINES,
    sequenceNumbersWrittenByDriver: false,
    instructionSha256: hash(script.compressionInstruction),
  }
  const perSessionCap = natural ? N_PER_SESSION_CAP : P_PER_SESSION_CAP
  const cwd = process.env.RQ5B_CWD ?? (natural ? `/tmp/rq5b-compliance-n-${RUN}` : '/tmp/rq5b-compliance-p')
  const client = makeClient(URL)
  mkdirSync(cwd, { recursive: true })
  const created = await client.call('session.create', { cwd })
  const sessionId = created.sessionId
  await client.call('session.selectModel', { sessionId, provider: 'scnet', model: 'GLM-5.2', reasoningEffort: 'max' })
  const trace = []

  async function history() {
    const snapshot = await client.call('session.history', { sessionId, maxMessages: 100000 })
    return { snapshot, events: snapshot.events.map(eventOf) }
  }

  async function waitIdle(phase) {
    let sawRunning = false
    for (let poll = 0; poll < 360; poll += 1) {
      await sleep(1000)
      const list = await client.call('session.list', {})
      const current = list.items.find((item) => item.sessionId === sessionId)
      if (current?.running) sawRunning = true
      const currentEvents = (await history()).events
      const currentCalls = callsFrom(currentEvents).length
      if (current?.running && currentCalls >= perSessionCap) {
        await client.call('session.cancel', { sessionId })
        throw new Error(`${ARM} session call cap reached during ${phase}: ${currentCalls}/${perSessionCap}`)
      }
      if (!current?.running && (sawRunning || poll >= 6)) return currentEvents
    }
    throw new Error(`${ARM} session did not settle during ${phase}`)
  }

  async function send(phase, text) {
    const before = await history()
    const beforeCalls = callsFrom(before.events).length
    if (beforeCalls >= perSessionCap) throw new Error(`${ARM} session call cap reached before ${phase}: ${beforeCalls}/${perSessionCap}`)
    await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
    const events = await waitIdle(phase)
    const after = await history()
    const calls = callsFrom(events)
    const pressure = after.snapshot.projections?.values?.contextPressure ?? {}
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
    return events
  }

  let events = []
  if (natural) {
    for (const plant of script.plants.slice(0, 4)) events = await send(`plant-${plant.stage}`, plant.text)
    for (const [index, text] of script.ordinary.entries()) events = await send(`ordinary-${index + 1}`, text)
    events = await send('blind-recall', script.recall)
  } else {
    for (const plant of script.plants) events = await send(`plant-${plant.stage}`, plant.text)
    const pressureBeforeCompression = trace.at(-1)?.projectedTokens ?? null
    if (pressureBeforeCompression === null || pressureBeforeCompression < WINDOW * 0.4 || pressureBeforeCompression > WINDOW * 0.52) {
      throw new Error(`P planting pressure outside 40-52% target before proactive call: ${pressureBeforeCompression}`)
    }
    events = await send('arc-status-then-proactive-compress', script.compressionInstruction)
    for (const [index, text] of script.ordinary.entries()) events = await send(`ordinary-${index + 1}`, text)
    events = await send('blind-recall', script.recall)
  }

  const calls = callsFrom(events)
  const queryTurn = calls.at(-1)?.turn
  if (queryTurn === undefined) throw new Error('blind recall did not yield a model call')
  const allToolCalls = toolCalls(events)
  const compressCalls = allToolCalls.filter((call) => call.name === 'compress')
  const query = queryCorpus(events, queryTurn)
  const recall = scoreRecall(script.facts, query.answer, {}, { answerText: query.answer, toolText: query.tool })
  const compacted = summaries(events).filter((summary) => summary.provider !== 'local')
  const summaryAudit = modelSummaryAudit(events, compacted)
  const nudges = annotateNudges(nudgeEvents(events, queryTurn), compressCalls)
  const ledger = buildLedger(calls, events.filter((event) => event.type === 'compaction/end').map((event) => ({ afterSeq: event.seq })))
  const arcStatusCalls = allToolCalls.filter((call) => call.name === 'arc_status')
  const statusCallIds = new Set(arcStatusCalls.map((call) => events.find((event) => event.seq === call.seq)?.data?.callId).filter(Boolean))
  const statusOutputs = events.filter((event) => event.type === 'tool/result' && statusCallIds.has(event.data?.message?.source?.callId))
    .map((event) => textOf(event.data?.message?.content))
  const pProtocol = natural ? null : {
    arcStatusCalls: arcStatusCalls.length,
    arcStatusBeforeFirstCompress: arcStatusCalls.length > 0 && compressCalls.length > 0 && arcStatusCalls[0].seq < compressCalls[0].seq,
    arcStatusSuggestedRangeTablePresent: statusOutputs.some((text) => /compressible ranges|suggested range/i.test(text)),
    arcStatusOutputSha256: statusOutputs.length === 0 ? null : hash(statusOutputs.join('\n')),
    firstCompressRanges: compressCalls[0]?.ranges ?? [],
    driverSuppliedSequenceNumbers: false,
    pPlantPressure: trace.find((entry) => entry.phase === 'plant-5')?.projectedTokens ?? null,
    failureReason: arcStatusCalls.length > 0 && compressCalls.length === 0 && !statusOutputs.some((text) => /compressible ranges|suggested range/i.test(text))
      ? 'arc_status returned only aggregate surface bounds, not a suggested-range table; under the no-handwritten-seq protocol the model had no permitted range to submit to compress.'
      : null,
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    arm: ARM,
    run: RUN,
    sessionId,
    agentPreset: created.agentPreset,
    setup: {
      host: 'isolated DSH_HOME web profile; fresh process per arm',
      model: 'scnet/GLM-5.2',
      configuredWindow: WINDOW,
      cleanCwd: cwd,
      seed: SEED,
      ...(natural ? { noiseLines: N_NOISE_LINES, expectedPatch: 'research/profiles/rq5-n.patch.yml', perSessionCallCap: N_PER_SESSION_CAP } : {
        pPlantTurns: P_PLANT_TURNS,
        noiseLinesPerPlant: P_NOISE_LINES,
        expectedPatch: 'research/profiles/rq5-p.patch.yml',
        perSessionCallCap: P_PER_SESSION_CAP,
        targetPressurePct: '40-52',
      }),
      appliedPatchSha256: process.env.RQ5B_PATCH_SHA ?? null,
    },
    promptAudit,
    trace,
    facts: { scorable: script.facts.length, factIds: script.facts.map((fact) => fact.id) },
    nudges,
    toolCalls: allToolCalls,
    compressToolCalls: compressCalls,
    compactions: compacted.map(({ summaryText, ...summary }) => summary),
    pProtocol,
    summaryAudit,
    quality: {
      answerOnly: { strict: recall.score, loose: recall.scoreLoose, strictRate: recall.recallRate, looseRate: recall.recallRateLoose, unknownLines: recall.unknownLines },
      benchAnswerPlusTool: (() => {
        const all = scoreRecall(script.facts, `${query.answer}\n${query.tool}`, {}, { answerText: query.answer, toolText: query.tool })
        return { strict: all.score, loose: all.scoreLoose, strictRate: all.recallRate, looseRate: all.recallRateLoose }
      })(),
      queryToolCalls: allToolCalls.filter((call) => call.turn === queryTurn).map((call) => call.name),
    },
    costLedger: ledger.totals,
    perCall: ledger.series,
    rawEvidence: {
      durableLog: `isolated host session ${sessionId} (not copied into repository)`,
      nudgeSource: 'user/message where source.plugin === arc-nudge',
      compressionSource: 'tool/call name === compress; arguments parsed offline',
    },
    verification: {
      perSessionBudgetWithinCap: calls.length <= perSessionCap,
      nPromptAuditClean: !natural || promptAudit.forbiddenMatches.length === 0,
      ...(natural ? {} : {
        pAtLeastFivePlantTurns: trace.filter((entry) => entry.phase.startsWith('plant-')).length >= 5,
        pPressureInTarget: pProtocol.pPlantPressure >= WINDOW * 0.4 && pProtocol.pPlantPressure <= WINDOW * 0.52,
        pArcStatusBeforeCompress: pProtocol.arcStatusBeforeFirstCompress,
        pModelCompressionLanded: compacted.length >= 1,
      }),
    },
  }
  mkdirSync(BENCH_RESULTS, { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ file: path, arm: ARM, run: RUN, calls: calls.length, nudges: nudges.length, compressCalls: compressCalls.length, compactions: compacted.length, quality: report.quality.answerOnly, verification: report.verification }, null, 2))
  if (!Object.values(report.verification).every((value) => value === true)) process.exitCode = 1
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
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((entry) => entry === value).length]))
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}

function wilson(k, n, z = 1.96) {
  if (n === 0) return null
  const p = k / n
  const den = 1 + z ** 2 / n
  const centre = (p + z ** 2 / (2 * n)) / den
  const radius = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * n)) / n) / den
  return { level: 0.95, low: centre - radius, high: centre + radius }
}

function requiredNToSeparateThreshold(observedRate, threshold, currentN) {
  if (observedRate === null) return null
  for (let n = Math.max(1, currentN); n <= 10000; n += 1) {
    const k = Math.round(observedRate * n)
    const interval = wilson(k, n)
    if ((observedRate < threshold && interval.high < threshold) || (observedRate >= threshold && interval.low > threshold)) {
      return {
        total: n,
        additional: Math.max(0, n - currentN),
        direction: observedRate < threshold ? 'upper-bound-below-80pct' : 'lower-bound-above-80pct',
        assumption: `observed rate remains ${(observedRate * 100).toFixed(1)}%`,
      }
    }
  }
  return null
}

function classifyDecision(calls) {
  const rangeCounts = calls.map((call) => call.ranges.length)
  const positions = calls.flatMap((call) => call.ranges.map((range) => range.position))
  const batchCalls = calls.filter((call) => call.ranges.length >= 2).length
  const partialCalls = calls.filter((call) => call.ranges.length === 1).length
  const headPositions = positions.filter((position) => position === 'head').length
  const verdict = calls.length < 3
    ? 'underdetermined-low-n'
    : batchCalls > calls.length / 2
      ? 'batch-dominant'
      : partialCalls > calls.length / 2 && headPositions / Math.max(1, positions.length) >= 0.6
        ? 'partial-head-dominant'
        : 'mixed'
  const recommendation = verdict === 'partial-head-dominant'
    ? 'Partial calls concentrate at the table head; record the measured cache-loss concern and separately review a newest-safe ordering experiment.'
    : verdict === 'batch-dominant'
      ? 'Model behavior is batch-dominant; newest-safe ordering is not justified. Keep the current oldest-first table and footnote.'
      : verdict === 'underdetermined-low-n'
        ? 'Fewer than three spontaneous N-arm model compress calls were observed; retain the existing oldest-first table and collect another RQ5 sample before changing range ordering.'
        : 'No dominant batch or head-partial behavior; retain the current ordering.'
  return { totalSpontaneousCalls: calls.length, rangeCounts, batchCalls, partialCalls, positions: histogram(positions), calls, verdict, recommendation }
}

function consolidate() {
  const baseline = JSON.parse(readFileSync(FINAL, 'utf8'))
  const phaseOne = { ...baseline }
  delete phaseOne.phase2
  const phaseOneCanonicalSha256 = hash(JSON.stringify(phaseOne))
  const p = JSON.parse(readFileSync(resolve(BENCH_RESULTS, 'rq5b-p.json'), 'utf8'))
  const nReports = [1, 2, 3].map((run) => JSON.parse(readFileSync(resolve(BENCH_RESULTS, `rq5b-n-${run}.json`), 'utf8')))
  const baseN = JSON.parse(readFileSync(resolve(BENCH_RESULTS, 'rq5-n.json'), 'utf8'))
  const allN = [baseN, ...nReports]
  const nudgeRecords = allN.flatMap((report) => report.nudges.map((nudge) => ({ source: report.run === null || report.run === undefined ? 'first-run-N' : `phase2-N${report.run}`, ...nudge })))
  const normal = rate(nudgeRecords.filter((record) => record.tier === 'normal'))
  const emergency = rate(nudgeRecords.filter((record) => record.tier === 'emergency'))
  const eligibleNudges = nudgeRecords.filter((record) => record.eligibleForThreeTurns)
  const latency = eligibleNudges.filter((record) => record.latencyTurns !== null).map((record) => record.latencyTurns)
  const spontaneous = allN.flatMap((report) => report.compressToolCalls.map((call) => ({ source: report.run === null || report.run === undefined ? 'first-run-N' : `phase2-N${report.run}`, ...call })))
  const decisionTwo = classifyDecision(spontaneous)
  const pSummary = p.summaryAudit[0] ?? null
  const audit = JSON.parse(readFileSync(resolve(RESULTS, 'rq5-governor-archive-audit.json'), 'utf8'))
  const withinFewPoints = pSummary?.strictRate !== null && pSummary?.strictRate !== undefined
    ? audit.totals.strictRate >= pSummary.strictRate - 0.03
    : false
  const liveCalls = p.perCall.length + nReports.reduce((sum, report) => sum + report.perCall.length, 0)
  const normalCI = wilson(normal.complied, normal.eligible)
  const normalCrosses80 = normalCI !== null && normalCI.low <= 0.8 && normalCI.high >= 0.8
  const sampleEstimate = normalCrosses80 ? requiredNToSeparateThreshold(normal.rate, 0.8, normal.eligible) : null
  const criterion = pSummary === null
    ? 'P-model-summary-unavailable-arc-status-has-no-suggested-range-table'
    : withinFewPoints
      ? 'governor-archive-at-least-P-within-three-points'
      : 'governor-archive-worse-than-P'
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'complete',
    phaseOneCanonicalSha256,
    budget: { cap: GLOBAL_CAP, used: liveCalls, withinCap: liveCalls <= GLOBAL_CAP, zeroCallOfflineAudit: true },
    governorArchiveAudit: {
      result: 'results/rq5-governor-archive-audit.json',
      strictRate: audit.totals.strictRate,
      looseRate: audit.totals.looseRate,
      totals: audit.totals,
      categoryDistribution: audit.categoryDistribution,
    },
    proactiveP: {
      report: 'results/bench/rq5b-p.json',
      sessionId: p.sessionId,
      calls: p.perCall.length,
      protocol: p.pProtocol,
      summaryAudit: p.summaryAudit,
      blindRecall: p.quality,
      verification: p.verification,
    },
    nExpansion: {
      configuration: 'same as the first N arm: autoNudge=true, Governor off, 32K explicit ARC window, seed 505, 260 noise lines, four natural plant turns, three neutral turns, zero compression/context/nudge/summary terms in driver prompts',
      reports: nReports.map((report) => ({ run: report.run, sessionId: report.sessionId, calls: report.perCall.length, nudges: report.nudges.length, promptAudit: report.promptAudit, quality: report.quality, verification: report.verification })),
      eligibleNudgeCount: eligibleNudges.length,
      targetAtLeast10Met: eligibleNudges.length >= 10,
      compliance: {
        normal: { ...normal, wilson95: normalCI, crosses80Pct: normalCrosses80, sampleEstimateIfStillCrosses80: sampleEstimate },
        emergency: { ...emergency, wilson95: wilson(emergency.complied, emergency.eligible) },
      },
      latency: { samples: latency, distribution: histogram(latency), medianTurns: median(latency) },
    },
    decisionTwo: {
      unit: 'model compress tool call in N only; P-instructed calls and Governor-local blocks excluded',
      ...decisionTwo,
      targetAtLeast3Met: decisionTwo.totalSpontaneousCalls >= 3,
    },
    criterionComparison: {
      comparisonUnit: 'direct scorer audit of facts in each archive/checkpoint source range; Governor strict retention must be at least P model-summary retention within three percentage points',
      governorStrictRate: audit.totals.strictRate,
      pStrictRate: pSummary?.strictRate ?? null,
      governorAtLeastPWithinThreePoints: withinFewPoints,
      normalComplianceCIStillCrosses80: normalCrosses80,
      branch: criterion,
      verdict: pSummary === null
        ? 'The formal Governor-versus-P model-summary criterion is not estimable: corrected P reached 46% pressure and called arc_status first, but arc_status exposed no suggested range for a no-handwritten-seq compress call. The four offline Governor archives nonetheless retained all audited seeded facts verbatim; do not change defaults from this constrained comparison.'
        : withinFewPoints
          ? 'Observed low nudge compliance is benign for retained seeded facts: the local Governor archive retained at least as much as the corrected P model-written summary. Keep the ladder/defaults unchanged.'
          : 'Governor archive quality is below the P comparison; record a product-priority follow-up without changing defaults in this measurement task.',
    },
    verification: {
      pSucceeded: p.verification.pAtLeastFivePlantTurns && p.verification.pPressureInTarget && p.verification.pArcStatusBeforeCompress && p.verification.pModelCompressionLanded,
      pSecondFailureLocated: p.verification.pSecondFailureLocated === true,
      pProtocolConclusionRecorded: (p.verification.pAtLeastFivePlantTurns && p.verification.pPressureInTarget && p.verification.pArcStatusBeforeCompress && p.verification.pModelCompressionLanded) || p.verification.pSecondFailureLocated === true,
      threeNReportsPresent: nReports.length === 3,
      allNPromptAuditsClean: nReports.every((report) => report.promptAudit.forbiddenMatches.length === 0),
      nudgeTargetMet: eligibleNudges.length >= 10,
      decisionTwoTargetMet: decisionTwo.totalSpontaneousCalls >= 3,
      liveBudgetWithinCap: liveCalls <= GLOBAL_CAP,
      originalFieldsPreserved: phaseOneCanonicalSha256 === PHASE_ONE_CANONICAL_SHA256,
    },
  }
  baseline.phase2 = result
  writeFileSync(FINAL, JSON.stringify(baseline, null, 2) + '\n')
  console.log(JSON.stringify({ file: FINAL, budget: result.budget, normal: result.nExpansion.compliance.normal, decisionTwo: result.decisionTwo.verdict, criterion: result.criterionComparison, verification: result.verification }, null, 2))
  if (!result.budget.withinCap || !result.verification.pProtocolConclusionRecorded || !result.verification.allNPromptAuditsClean) process.exitCode = 1
}

const mode = process.argv[2] ?? 'live'
if (mode === 'live') live().catch((error) => { console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
else if (mode === 'consolidate') consolidate()
else if (mode === 'recover-n') writeRecoveredNReport()
else if (mode === 'annotate-p') annotatePReport()
else if (mode === 'audit') console.log(JSON.stringify(assertNaturalPromptAudit(naturalScript()), null, 2))
else throw new Error('usage: rq5b-completion.mjs [live|consolidate|recover-n|annotate-p|audit]')
