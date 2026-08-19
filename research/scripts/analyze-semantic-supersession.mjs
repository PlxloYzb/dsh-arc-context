#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const keyPath = resolve(process.argv[2] ?? '')
const runDir = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3]) {
  console.error('usage: node analyze-semantic-supersession.mjs ANSWER_KEY RUN_DIR')
  process.exit(2)
}
const key = JSON.parse(readFileSync(keyPath, 'utf8'))
const evidence = join(runDir, '__evidence__')
const frames = readFileSync(join(evidence, 'mux-events.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse)
const events = frames.map((frame) => frame?.payload?.event).filter(Boolean)
const projections = frames.map((frame) => frame?.payload).filter((payload) => payload?.type === 'session/projection')
const lastProjection = (name) => projections.filter((item) => item.key === name).at(-1)?.value ?? null
const assistant = events.filter((event) => event.type === 'assistant/message')
const finalTurn = Math.max(...assistant.map((event) => event.data?.turn).filter(Number.isFinite))
const finalText = assistant.filter((event) => event.data?.turn === finalTurn)
  .flatMap((event) => event.data?.message?.content ?? [])
  .filter((block) => block.type === 'text').map((block) => block.text).join('\n')
const summaries = events.filter((event) => event.type === 'compaction/summary')
const headers = events.filter((event) => event.type === 'request/header')
const toolCalls = events.filter((event) => event.type === 'tool/call')
const matchesCriteria = (text, groups) => groups.every((alternatives) => alternatives.some((value) => text.includes(value)))
const currentHits = key.expected.filter(([name, value]) => key.currentCriteria?.[name]
  ? matchesCriteria(finalText, key.currentCriteria[name])
  : finalText.includes(value))
const reasonHits = (key.reasonCriteria ?? key.reasons.map((value) => [[value]]))
  .filter((criteria) => matchesCriteria(finalText, criteria))
const obsoleteLeaks = key.obsolete.filter((value) => finalText.replace(/\s+/g, '').includes(value.replace(/\s+/g, '')))
const result = {
  generatedAt: new Date().toISOString(),
  runId: basename(runDir),
  seed: key.seed,
  model: JSON.parse(readFileSync(join(evidence, 'run-meta.json'), 'utf8')).model,
  requestHeaders: {
    count: headers.length,
    maxTokens: [...new Set(headers.map((event) => event.data?.header?.config?.maxTokens))],
    adapterDefaultMaxTokens: headers.filter((event) => event.data?.header?.adapterDefaults?.maxTokens === true).length,
  },
  sessionUsage: lastProjection('tokenUsage'),
  finalContextPressure: lastProjection('contextPressure'),
  currentState: {
    recalled: currentHits.length,
    expected: key.expected.length,
    missing: key.expected.filter(([name, value]) => key.currentCriteria?.[name]
      ? !matchesCriteria(finalText, key.currentCriteria[name])
      : !finalText.includes(value)).map((entry) => entry[0]),
  },
  rationale: {
    recalled: reasonHits.length,
    expected: key.reasons.length,
    missing: (key.reasonCriteria ?? key.reasons.map((value) => [[value]]))
      .map((criteria, index) => ({ criteria, label: key.reasons[index] }))
      .filter(({ criteria }) => !matchesCriteria(finalText, criteria)).map(({ label }) => label),
  },
  obsoleteContamination: { count: obsoleteLeaks.length, leakedPatterns: obsoleteLeaks },
  toolCalls: { count: toolCalls.length, finalTurnCount: toolCalls.filter((event) => event.data?.turn === finalTurn).length },
  compactions: summaries.map((event) => ({
    provider: event.data.provider ?? null,
    model: event.data.model ?? null,
    shadowedNodes: event.data.shadowedSeqs?.length ?? 0,
    shadowedTokenCount: event.data.shadowedTokenCount ?? null,
    summaryChars: event.data.summary?.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) ?? 0,
    usage: event.data.usage ?? null,
  })),
  errors: events.filter((event) => /(?:error|failed)$/.test(event.type)).map((event) => event.type),
  finalText,
}
const output = resolve(process.env.OUTPUT ?? join(keyPath, '..', '..', 'semantic-supersession-results.json'))
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(output)
console.log(JSON.stringify({ ...result, finalText: `${finalText.slice(0, 500)}…` }, null, 2))
