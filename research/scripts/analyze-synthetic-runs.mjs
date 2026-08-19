#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const specs = process.argv.slice(2)
if (specs.length === 0) {
  console.error('usage: node analyze-synthetic-runs.mjs RUN_DIR:ANSWER_KEY [...]')
  process.exit(2)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function analyze(spec) {
  const split = spec.indexOf(':')
  if (split < 0) throw new Error(`missing : in ${spec}`)
  const runDir = resolve(spec.slice(0, split))
  const keyPath = resolve(spec.slice(split + 1))
  const evidence = join(runDir, '__evidence__')
  const muxFiles = [
    'mux-events.jsonl',
    ...readdirSync(evidence).filter((name) => name.startsWith('mux-events-continuation-')).sort(),
  ]
  const frames = muxFiles.flatMap((name) => readFileSync(join(evidence, name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse))
  const events = frames
    .map((frame) => frame?.payload?.event)
    .filter((event) => event && typeof event === 'object')
  const projections = frames
    .map((frame) => frame?.payload)
    .filter((payload) => payload?.type === 'session/projection')

  const headerCaps = events
    .filter((event) => event.type === 'request/header')
    .map((event) => event.data?.header?.config?.maxTokens)
    .filter((value) => Number.isFinite(value))
  const calls = events
    .filter((event) => event.type === 'tool/call')
    .map((event) => event.data?.name)
  const toolErrors = events
    .filter((event) => event.type === 'tool/result')
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((block) => block?.type === 'tool-result' && block.isError === true)
  const compactionErrors = events
    .filter((event) => event.type === 'compaction/end' && typeof event.data?.error === 'string')
  const providerErrors = events.filter((event) => /(?:^|\/)(?:error|failed)$/.test(event.type))

  const lastProjection = (key) => projections
    .filter((projection) => projection.key === key && projection.value)
    .at(-1)?.value ?? null
  const usage = lastProjection('tokenUsage')
  const pressure = lastProjection('contextPressure')
  const denominator = (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0)

  const summaries = events.filter((event) => event.type === 'compaction/summary')
  const assistant = events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => ({
      turn: event.data?.turn,
      step: event.data?.step,
      text: (event.data?.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
      usage: event.data?.usage ?? null,
    }))
  const lastTurn = Math.max(...assistant.map((message) => message.turn).filter(Number.isFinite))
  const finalText = assistant.filter((message) => message.turn === lastTurn).map((message) => message.text).join('\n')
  const answerKey = readJson(keyPath)
  const expected = answerKey.expected.flatMap((row) => row.canaries)
  const recalled = expected.filter((canary) => finalText.includes(canary))

  const meta = readJson(join(evidence, 'run-meta.json'))
  const stagePressure = meta.stageRecords.map((stage) => ({
    stage: stage.stage,
    projectedTokens: stage.projectionsAfter?.values?.contextPressure?.projectedTokens ?? null,
    usage: stage.projectionsAfter?.values?.tokenUsage ?? null,
  }))
  return {
    runId: basename(runDir),
    model: meta.model,
    stages: answerKey.expected.length,
    apiUsage: usage,
    cacheReadFraction: denominator === 0 ? null : (usage.cacheReadTokens / denominator),
    finalContextPressure: pressure,
    recordedRequestHeaderCaps: headerCaps,
    toolCalls: Object.fromEntries([...new Set(calls)].sort().map((name) => [name, calls.filter((x) => x === name).length])),
    compactions: summaries.map((event) => ({
      compactionId: event.data.compactionId,
      provider: event.data.provider ?? null,
      model: event.data.model ?? null,
      usage: event.data.usage ?? null,
      llmStreamCall: event.data.llmStreamCall ?? null,
      shadowedRange: event.data.shadowedRange,
      shadowedNodes: event.data.shadowedSeqs?.length ?? 0,
      shadowedTokenCount: event.data.shadowedTokenCount,
      summaryChars: event.data.summary?.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) ?? 0,
    })),
    errors: {
      tool: toolErrors.length,
      compaction: compactionErrors.length,
      providerOrTurn: providerErrors.length,
    },
    finalRecall: {
      recalled: recalled.length,
      expected: expected.length,
      missing: expected.filter((canary) => !finalText.includes(canary)),
    },
    maxAssistantOutputTokens: Math.max(...assistant.map((message) => message.usage?.outputTokens ?? 0)),
    stagePressure,
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  note: 'API usage is the final DSH tokenUsage projection: uncached input, output, and cache-read tokens. No price conversion.',
  runs: specs.map(analyze),
}
const outPath = resolve('work/context-governor-research/live-synthetic-results.json')
writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n')
console.log(outPath)
console.log(JSON.stringify(output, null, 2))
