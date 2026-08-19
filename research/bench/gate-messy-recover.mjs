#!/usr/bin/env node
/**
 * Recover a beta.9 decision-C messy-gate arm whose driver stalled after the
 * session had already settled. Rebuilds the exact gate-completion-messy.mjs
 * report from the persisted host session log, using the same scorer and the
 * same-seed A-arm file as the canonical fact set (factsFor is embedded in the
 * original driver and seed-tagged [S1]/[S2]).
 *
 * usage: node research/bench/gate-messy-recover.mjs <A-1|A-2|B-1|B-2> <session.jsonl> [outDir]
 *
 * Refuses to overwrite a driver-written result unless FORCE_RECOVER=1.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scoreRecall } from './scorer.mjs'

const ARM = process.argv[2]
const SESSION_LOG = process.argv[3]
const OUT = resolve(process.argv[4] ?? 'research/results/bench')
if (!/^[AB]-[12]$/.test(ARM ?? '')) throw new Error('usage: gate-messy-recover.mjs <A-1|A-2|B-1|B-2> <session.jsonl> [outDir]')
if (!SESSION_LOG || !existsSync(SESSION_LOG)) throw new Error(`session log not found: ${SESSION_LOG}`)

const ev = (x) => x.event ?? x
const text = (x) => Array.isArray(x) ? x.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('') : String(x ?? '')
const seed = Number(ARM.slice(-1))
const tag = `S${seed}`

const factsFile = resolve(OUT, `gate-messy-A-${seed}.json`)
const facts = JSON.parse(readFileSync(factsFile, 'utf8')).facts
if (facts.length < 16 || !facts.every((f) => f.category === 'verbatim' && f.needle.includes(`[${tag}]`))) {
  throw new Error(`fact set in ${factsFile} is not the seed-${seed} verbatim set`)
}

const raw = readFileSync(SESSION_LOG, 'utf8')
const events = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).map(ev)
const sessionId = events.find((e) => e.type === 'session')?.id ?? null
const contextEvent = events.find((e) => e.type === 'request/context')?.data ?? null

const modelRouting = {
  preferred: 'opencode-go/deepseek-v4-flash',
  actual: contextEvent ? `${contextEvent.provider}/${contextEvent.model}` : 'unknown (no request/context event)',
  fallbackReason: null,
  note: 'reconstructed from the persisted request/context event; a single context covering every turn proves session.selectModel accepted the route',
}

const rows = events
  .filter((e) => e.type === 'assistant/message' && e.data?.usage)
  .map((e) => ({
    seq: e.seq, turn: e.data.turn, step: e.data.step,
    uncachedInputTokens: e.data.usage.uncachedInputTokens ?? e.data.usage.inputTokens ?? 0,
    cacheReadTokens: e.data.usage.cacheReadTokens ?? 0,
    outputTokens: e.data.usage.outputTokens ?? 0,
  }))

const userSourced = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
const plant = userSourced.find((e) => text(e.data?.content).startsWith('Messy archival batch'))
const compressInstruction = userSourced.find((e) => text(e.data?.content).startsWith('The archival batch is consumed'))
const instructed = compressInstruction ? /\{ startSeq: (\d+), endSeq: (\d+), summary/.exec(text(compressInstruction.data.content)) : null
if (!plant || !instructed) throw new Error('plant or compress-instruction message not found; the session is not a recoverable messy-gate arm')
const range = { startSeq: Number(instructed[1]), endSeq: Number(instructed[2]) }
if (plant.seq !== range.startSeq || range.startSeq !== range.endSeq) {
  throw new Error(`plant seq ${plant.seq} does not match instructed range ${range.startSeq}..${range.endSeq}`)
}

const summaries = events
  .filter((e) => e.type === 'compaction/summary')
  .map((e) => {
    const summaryText = text(e.data?.summary)
    const score = scoreRecall(facts, summaryText)
    return { seq: e.seq, summaryChars: summaryText.length, strict: score.score, strictRate: score.recallRate, scoreLoose: score.scoreLoose, perFact: score.perFact, summaryText }
  })

const latestTurn = Math.max(...rows.map((row) => row.turn))
const answer = events
  .filter((e) => e.type === 'assistant/message' && e.data?.turn === latestTurn)
  .map((e) => text(e.data?.message?.content)).join('\n')
const recall = scoreRecall(facts, answer)
const auditTurnSettled = events.some((e) => e.type === 'turn/end' && (e.data?.turn ?? e.turn) === latestTurn)
  || events.filter((e) => e.type === 'turn/end').length >= latestTurn + 1

const total = rows.reduce((a, row) => ({
  uncachedInputTokens: a.uncachedInputTokens + row.uncachedInputTokens,
  cacheReadTokens: a.cacheReadTokens + row.cacheReadTokens,
  outputTokens: a.outputTokens + row.outputTokens,
}), { uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 })

const verification = {
  exactlyOneModelWrittenCompaction: summaries.length === 1,
  noRetrievalTools: !events.some((e) => e.type === 'tool/call' && ['arc_status', 'search_context', 'decompress'].includes(e.data?.name)),
  atLeast16VerbatimFacts: facts.length >= 16,
  withinPerArmCallCap: rows.length <= 5,
  auditTurnSettled,
}

const report = {
  schemaVersion: 1,
  experiment: 'beta.9 decision-C messy-content gate',
  arm: ARM,
  seed,
  guidance: ARM[0] === 'A' ? 'full-preC-template-injected' : 'current-compact-default',
  sessionId,
  modelRouting,
  setup: {
    configuredWindow: 32768,
    protectedRecentMessages: 0,
    protectedRecentTokens: 1,
    primaryLiveTurns: 3,
    perArmCallCap: 5,
    contentClasses: ['real code signatures/functions', 'realistic stack/error strings', 'free discussion', 'Chinese-English mixed facts'],
    verbatimFactCount: facts.length,
  },
  systemTokensAfterPlant: null,
  plantedRange: range,
  facts,
  compactions: summaries.map(({ summaryText, ...rest }) => rest),
  blindRecall: { strict: recall.score, strictRate: recall.recallRate, perFact: recall.perFact },
  rawModelCalls: rows.length,
  perCall: rows,
  rawTokenTotals: { ...total, totalPromptTokens: total.uncachedInputTokens + total.cacheReadTokens },
  verification,
  provenance: {
    reconstructed: true,
    recoveryTool: 'research/bench/gate-messy-recover.mjs',
    recoveredAt: new Date().toISOString().slice(0, 10),
    reason: 'commission driver stalled after the audit turn settled; the host session log is mechanically complete (plant -> single compress -> blind audit)',
    sourceSessionLog: SESSION_LOG,
    sessionLogSha256: createHash('sha256').update(raw).digest('hex'),
    observedContextWindow: contextEvent?.contextWindow ?? null,
    systemTokensAfterPlantNote: 'history projections are not persisted in the session log; left null (diagnostic only, never a gate input)',
    recoveredTexts: { compactionSummary: summaries[0]?.summaryText ?? null, blindAuditAnswer: answer },
  },
}

mkdirSync(OUT, { recursive: true })
const file = resolve(OUT, `gate-messy-${ARM}.json`)
if (existsSync(file) && process.env.FORCE_RECOVER !== '1') {
  throw new Error(`${file} already exists (driver-written artifact); set FORCE_RECOVER=1 to overwrite`)
}
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ file, arm: ARM, seed, sessionId, calls: rows.length, summary: summaries.map((s) => s.strict), recall: recall.score, auditTurnSettled, modelRouting: modelRouting.actual }, null, 2))
if (!Object.values(verification).every(Boolean)) process.exitCode = 1
