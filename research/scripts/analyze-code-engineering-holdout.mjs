#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const keyPath = resolve(process.argv[2] ?? '')
const runDir = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3]) {
  console.error('usage: node analyze-code-engineering-holdout.mjs ANSWER_KEY RUN_DIR')
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

const recalled = key.expected.filter(({ value }) => finalText.includes(value))
const derived = Object.entries(key.derived).filter(([, value]) => finalText.includes(value))
const summaries = events.filter((event) => event.type === 'compaction/summary')
const toolCalls = events.filter((event) => event.type === 'tool/call')
const headers = events.filter((event) => event.type === 'request/header')
let projectTests
try {
  projectTests = { passed: true, output: execFileSync('npm', ['test'], { cwd: runDir, encoding: 'utf8', timeout: 120000 }) }
} catch (error) {
  projectTests = { passed: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
}
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
  exactProofs: {
    recalled: recalled.length,
    expected: key.expected.length,
    missingKeys: key.expected.filter(({ value }) => !finalText.includes(value)).map(({ key: name }) => name),
  },
  derived: {
    recalled: derived.length,
    expected: Object.keys(key.derived).length,
    missing: Object.entries(key.derived).filter(([, value]) => !finalText.includes(value)).map(([name]) => name),
  },
  projectTests: { passed: projectTests.passed, tail: projectTests.output.slice(-1500) },
  toolCalls: {
    count: toolCalls.length,
    finalTurnCount: toolCalls.filter((event) => event.data?.turn === finalTurn).length,
    names: Object.fromEntries([...new Set(toolCalls.map((event) => event.data?.name))].map((name) => [name, toolCalls.filter((event) => event.data?.name === name).length])),
  },
  compactions: summaries.map((event) => ({
    provider: event.data.provider ?? null,
    model: event.data.model ?? null,
    shadowedNodes: event.data.shadowedSeqs?.length ?? 0,
    shadowedTokenCount: event.data.shadowedTokenCount ?? null,
    summaryChars: event.data.summary?.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) ?? 0,
    usage: event.data.usage ?? null,
  })),
  errors: events.filter((event) => /(?:error|failed)$/.test(event.type)).map((event) => event.type),
}
const output = resolve(process.env.OUTPUT ?? join(keyPath, '..', '..', 'code-engineering-holdout-results.json'))
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(output)
console.log(JSON.stringify(result, null, 2))
