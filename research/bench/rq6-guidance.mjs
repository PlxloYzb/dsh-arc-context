#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeClient } from './driver.mjs'
import { generateFacts } from './facts.mjs'
import { scoreRecall } from './scorer.mjs'

const URL = process.env.RQ6_URL ?? 'http://127.0.0.1:8933'
const CWD = process.env.RQ6_CWD ?? '/tmp/rq6-guidance-workspace'
const ARM = process.env.RQ6_ARM
const OUT = resolve(process.env.RQ6_OUT ?? 'research/results/bench')
const MODEL = { provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
if (!/^[AB]-[12]$/.test(ARM ?? '')) throw new Error('RQ6_ARM must be A-1, A-2, B-1, or B-2')
const ev = (x) => x.event ?? x
const text = (x) => Array.isArray(x) ? x.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('') : String(x ?? '')

async function idle(client, sessionId) {
  let sawRunning = false
  for (let poll = 0; poll < 180; poll += 1) {
    await sleep(2000)
    const session = (await client.call('session.list', {})).items.find((item) => item.sessionId === sessionId)
    if (session?.running === true) sawRunning = true
    // A queued web-profile request can remain `running:false` for tens of
    // seconds before the host starts its model step.  Do not snapshot the
    // next prompt's history after the old 14-second grace window: that races
    // blind recall and produces a null score.  Once observed, a false state
    // is definitive; otherwise permit a one-minute dispatch grace.
    else if (sawRunning || poll > 30) return
  }
  throw new Error('session did not settle within 6 minutes')
}
async function prompt(client, sessionId, body) {
  await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: body }] })
  await idle(client, sessionId)
}
function callRows(events) {
  return events.map(ev).filter((entry) => entry.type === 'assistant/message' && entry.data?.usage).map((entry) => ({
    turn: entry.data.turn, step: entry.data.step, seq: entry.seq,
    uncachedInputTokens: entry.data.usage.uncachedInputTokens ?? entry.data.usage.inputTokens ?? 0,
    cacheReadTokens: entry.data.usage.cacheReadTokens ?? 0, outputTokens: entry.data.usage.outputTokens ?? 0,
  }))
}
function factLine(fact) {
  return fact.category === 'paraphrase' ? fact.statement : fact.category === 'crossref' ? `${fact.needle} ${fact.refs.join(' ')}` : fact.statement ?? fact.needle
}
function plant(facts) {
  return `RQ6 archival batch. Treat every following record as data for a later blind audit. Do not use tools and reply exactly ACK-1.\n\n${facts.map((fact) => `- [${fact.id}] ${factLine(fact)}`).join('\n')}`
}
function latestPlantRange(events) {
  const entries = events.map(ev)
  const user = entries.filter((entry) => entry.type === 'user/message' && entry.data?.source?.kind === 'user').at(-1)
  if (user === undefined) throw new Error('could not derive planted surface range')
  // The v3 control reduces ARC's protected tail to one token.  Compress the
  // planted user record itself, leaving its ACK as the newer tail; including
  // the ACK would make an edge depend on partial-token protection semantics.
  return { startSeq: user.seq, endSeq: user.seq }
}
function compact(range) {
  return `RQ6 compression round. The archival batch is fully consumed. Call compress exactly once for this CURRENT surface range: compress({ content: [{ startSeq: ${range.startSeq}, endSeq: ${range.endSeq}, summary: <your faithful dense summary> }] }). Follow your system summary discipline, especially KEEP-VERBATIM. Do not use arc_status, search_context, or decompress. After the tool succeeds, reply exactly COMPRESSED-1.`
}
function compactions(events, facts) {
  return events.map(ev).filter((entry) => entry.type === 'compaction/summary').map((entry, index) => {
    const score = scoreRecall(facts, text(entry.data?.summary)); const byCategory = {}
    for (const fact of score.perFact) {
      const bucket = byCategory[fact.category] ??= { strict: 0, loose: 0, total: 0 }
      bucket.total += 1; if (fact.hit) bucket.strict += 1; if (fact.hitLoose) bucket.loose += 1
    }
    return { round: index + 1, compactionId: entry.data?.compactionId ?? null, summaryChars: text(entry.data?.summary).length,
      strict: score.score, loose: score.scoreLoose, strictRate: score.recallRate, looseRate: score.recallRateLoose, byCategory, perFact: score.perFact }
  })
}

const seed = Number(ARM.split('-')[1])
// Eighty-two non-trap records (5K+ source characters before framing) keep the
// user-only v3 target above ARC's 5K-character gate without relying on model
// reasoning/tool noise or by compressing the active instruction. This remains
// the same >=20-all-category fixture protocol in every arm.
const facts = generateFacts(seed, { facts: 88, locale: 'en' }).filter((fact) => fact.category !== 'trap')
const client = makeClient(URL)
const created = await client.call('session.create', { cwd: CWD })
await client.call('session.selectModel', { sessionId: created.sessionId, ...MODEL })
await prompt(client, created.sessionId, plant(facts))
let history = await client.call('session.history', { sessionId: created.sessionId, maxMessages: 100000 })
const systemTokens = history.projections?.values?.contextBreakdown?.systemTokens ?? null
const range = latestPlantRange(history.events)
await prompt(client, created.sessionId, compact(range))
await prompt(client, created.sessionId, `RQ6 blind recall audit. Without tools, list every archived record below in its exact recorded form. If unknown, write UNKNOWN for that id. IDs: ${facts.map((fact) => fact.id).join(', ')}.`)
history = await client.call('session.history', { sessionId: created.sessionId, maxMessages: 100000 })
const events = history.events.map(ev), rows = callRows(events), lastTurn = Math.max(...rows.map((row) => row.turn))
const answer = events.filter((entry) => entry.type === 'assistant/message' && entry.data?.turn === lastTurn).flatMap((entry) => entry.data.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
const recall = scoreRecall(facts, answer), summaries = compactions(events, facts)
const totals = rows.reduce((acc, row) => ({ uncachedInputTokens: acc.uncachedInputTokens + row.uncachedInputTokens, cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens, outputTokens: acc.outputTokens + row.outputTokens }), { uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 })
totals.totalPromptTokens = totals.uncachedInputTokens + totals.cacheReadTokens
const report = { schemaVersion: 2, rq: 'RQ6', arm: ARM, guidance: ARM[0] === 'A' ? 'full-default' : 'compact-patch', seed,
  setup: { host: 'isolated verify/arc-live-rc7; dsh web; temporary profile overlay', model: 'opencode-go/deepseek-v4-flash', configuredWindow: 32768, primaryLiveTurns: 3, budget: { capPerArm: 6, primaryLiveTurnsPlanned: 3 }, nativePromptOverride: ARM[0] === 'B', experimentOnlyProtectionOverride: { protectedRecentMessages: 0, protectedRecentTokens: 1, productionDefault: { protectedRecentMessages: 5, protectedRecentTokens: 5000 } } },
  sessionId: created.sessionId, systemTokensAfterPlant: systemTokens, plantedFactCount: facts.length, plantedRange: range, facts, compactions: summaries,
  blindRecall: { strict: recall.score, loose: recall.scoreLoose, strictRate: recall.recallRate, looseRate: recall.recallRateLoose, perFact: recall.perFact }, rawModelCalls: rows.length, perCall: rows, rawTokenTotals: totals,
  verification: { oneModelWrittenCompaction: summaries.length === 1, noRetrievalTools: !events.some((entry) => entry.type === 'tool/call' && ['arc_status', 'search_context', 'decompress'].includes(entry.data?.name)), withinPerArmCap: rows.length <= 6 } }
mkdirSync(OUT, { recursive: true }); const file = resolve(OUT, `rq6-${ARM}.json`)
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ file, arm: ARM, systemTokens, plantedRange: range, rawModelCalls: rows.length, compactions: summaries.map((item) => item.strict), recall: recall.score }, null, 2))
