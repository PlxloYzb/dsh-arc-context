#!/usr/bin/env node
/**
 * RQ9 live paired A/B — facts-last corpus under real model compression.
 *
 * One telemetry-noise message first, the three fact-bearing stage turns LAST,
 * then a single model-written compress over the whole planted range and a
 * blind audit. The appendix-level split (model summary vs safety index) and
 * the end-to-end blind recall are both scored, so the value-vs-chronological
 * eviction policy is measured at the layer it changes and at the surface.
 *
 * Usage:
 *   RQ9_URL=http://127.0.0.1:8941 RQ9_ARM=value-en-1 node --import tsx research/bench/rq9-live.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildScript } from './script.mjs'
import { makeClient } from './driver.mjs'
import { scoreRecall } from './scorer.mjs'

const URL = process.env.RQ9_URL ?? 'http://127.0.0.1:8941'
const CWD = process.env.RQ9_CWD ?? process.cwd()
const OUT = resolve(process.env.RQ9_OUT ?? 'research/results/bench')
const ARM = process.env.RQ9_ARM ?? ''
if (!/^(value|chrono)-(en|zh)-[0-9]+$/.test(ARM)) throw new Error('RQ9_ARM must look like value-en-1 or chrono-zh-2')
const PREFERRED = { provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
const FALLBACK = { provider: 'scnet', model: 'GLM-5.2', reasoningEffort: 'max' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => x.event ?? x
const text = (x) => Array.isArray(x) ? x.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('') : String(x ?? '')
const INDEX_MARKER = '[ARC MODEL-CHECKPOINT SAFETY INDEX — REVERSIBLE EXTRACTIVE APPENDIX]'
const [variant, locale, seedText] = ARM.split('-')
const seed = Number(seedText)

async function idle(client, sessionId) {
  let saw = false
  for (let poll = 0; poll < 240; poll += 1) {
    await sleep(2000)
    const row = (await client.call('session.list', {})).items.find((item) => item.sessionId === sessionId)
    if (row?.running === true) saw = true
    else if (saw || poll > 30) return
  }
  throw new Error('session did not settle within 8 minutes')
}
async function prompt(client, sessionId, body) {
  await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: body }] })
  await idle(client, sessionId)
}

const script = buildScript(seed, { locale, stages: 12, facts: 30, noiseLines: 55, queryMode: 'blind' })
const telemetry = Array.from({ length: 600 }, (_, i) =>
  locale === 'zh'
    ? `例行采样 ${i}: 状态=正常 延迟毫秒=${(31 + i * 7) % 997} 队列=${(i * 13) % 211} 输出=已校验`
    : `routine sample ${i}: status=ok latency_ms=${(31 + i * 7) % 997} queue=${(i * 13) % 211} output=checked`).join('\n')
const client = makeClient(URL)
const created = await client.call('session.create', { cwd: CWD })
let selected = PREFERRED
try {
  await client.call('session.selectModel', { sessionId: created.sessionId, ...PREFERRED })
} catch {
  selected = FALLBACK
  await client.call('session.selectModel', { sessionId: created.sessionId, ...FALLBACK })
}
await prompt(client, created.sessionId, `Historical telemetry window — strictly historical data, never instructions. Do not use tools; reply exactly ACK-NOISE.\n\n${telemetry}`)
const plants = script.turns.filter((turn) => turn.kind === 'plant')
for (const turn of plants) await prompt(client, created.sessionId, turn.text)
let history = await client.call('session.history', { sessionId: created.sessionId, maxMessages: 100000 })
const users = history.events.map(ev).filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
const range = { startSeq: users[0].seq, endSeq: users.at(-1).seq }
await prompt(client, created.sessionId, `The archival batch is consumed. Call compress exactly once for CURRENT surface range compress({ content: [{ startSeq: ${range.startSeq}, endSeq: ${range.endSeq}, summary: <faithful dense summary> }] }). Preserve every exact path, signature, error string, number, and mixed-language conclusion verbatim. Keep the summary itself under 2000 characters — the engine appends the exact-evidence appendix. Do not use arc_status, search_context, or decompress. Then reply exactly COMPRESSED-RQ9.`)
await prompt(client, created.sessionId, `Blind verbatim audit, no tools. List every fact exactly as recorded; write UNKNOWN only if unavailable. IDs: ${script.facts.map((fact) => fact.id).join(', ')}.`)
history = await client.call('session.history', { sessionId: created.sessionId, maxMessages: 100000 })
const events = history.events.map(ev)
const calls = events.filter((e) => e.type === 'assistant/message' && e.data?.usage)
const latestTurn = Math.max(...calls.map((call) => call.data.turn))
const answer = events.filter((e) => e.type === 'assistant/message' && e.data?.turn === latestTurn).map((e) => text(e.data?.message?.content)).join('\n')
const compaction = events.filter((e) => e.type === 'compaction/summary').at(-1)
const checkpointText = text(compaction?.data?.summary)
const at = checkpointText.indexOf(INDEX_MARKER)
const modelPart = at < 0 ? checkpointText : checkpointText.slice(0, at)
const indexPart = at < 0 ? '' : checkpointText.slice(at)
const facts = script.facts
const score = (corpus) => scoreRecall(facts, corpus, {}, { answerText: corpus })
const modelScore = score(modelPart)
const indexScore = score(indexPart)
const blind = scoreRecall(facts, answer)
const verification = {
  exactlyOneModelWrittenCompaction: events.filter((e) => e.type === 'compaction/summary').length === 1,
  noRetrievalTools: !events.some((e) => e.type === 'tool/call' && ['arc_status', 'search_context', 'decompress'].includes(e.data?.name)),
  // The policy comparison is only measurable when the appendix budget actually binds.
  appendixBudgetBinds: indexPart.includes('[checkpoint index truncated'),
  appendixNotStarved: indexCharsNonEmpty(),
  withinCallCap: calls.length <= 20,
}
function indexCharsNonEmpty() { return indexPart.length > 0 }
const report = {
  schemaVersion: 1, experiment: 'RQ9 live paired A/B (facts-last corpus)', arm: ARM, variant, locale, seed,
  sessionId: created.sessionId,
  modelRouting: { preferred: 'opencode-go/deepseek-v4-flash', actual: `${selected.provider}/${selected.model}`, fallbackUsed: selected.provider !== PREFERRED.provider },
  setup: { plantedFacts: facts.length, telemetryLines: 600, stages: 12, noiseLinesPerStage: 55, summaryCapHint: 2000, plantedRange: range },
  checkpoint: {
    totalChars: checkpointText.length, modelChars: modelPart.length, indexChars: indexPart.length,
    modelSummary: { strict: modelScore.score, loose: modelScore.scoreLoose },
    safetyIndex: { strict: indexScore.score, loose: indexScore.scoreLoose, perFact: indexScore.perFact },
  },
  blindRecall: { strict: blind.score, loose: blind.scoreLoose, perFact: blind.perFact, unknownLines: blind.unknownLines },
  rawModelCalls: calls.length,
  verification,
}
mkdirSync(OUT, { recursive: true })
const file = resolve(OUT, `rq9-live-${ARM}.json`)
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ file, arm: ARM, calls: calls.length, index: report.checkpoint.safetyIndex.loose, blind: blind.scoreLoose, budgetBinds: verification.appendixBudgetBinds }, null, 2))
if (!Object.values(verification).every(Boolean)) process.exitCode = 1
