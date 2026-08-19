#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const keyPath = resolve(process.argv[2] ?? '')
const runDirs = process.argv.slice(3).map((path) => resolve(path))
if (!process.argv[2] || runDirs.length === 0) {
  console.error('usage: node analyze-randomized-paired.mjs ANSWER_KEY RUN_DIR [...]')
  process.exit(2)
}
const key = JSON.parse(readFileSync(keyPath, 'utf8'))

function addUsage(target, usage, inputField = 'uncachedInputTokens') {
  if (!usage) return
  target.uncachedInputTokens += usage[inputField] ?? 0
  target.outputTokens += usage.outputTokens ?? 0
  target.cacheReadTokens += usage.cacheReadTokens ?? 0
  target.cacheWriteTokens += usage.cacheWriteTokens ?? 0
}

function analyze(runDir) {
  const evidence = join(runDir, '__evidence__')
  const frames = readFileSync(join(evidence, 'mux-events.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(JSON.parse)
  const events = frames.map((frame) => frame?.payload?.event).filter(Boolean)
  const projections = frames.map((frame) => frame?.payload)
    .filter((payload) => payload?.type === 'session/projection')
  const lastProjection = (name) => projections.filter((item) => item.key === name).at(-1)?.value ?? null
  const sessionUsage = lastProjection('tokenUsage')
  const auxiliaryCompactionUsage = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  const summaries = events.filter((event) => event.type === 'compaction/summary')
  for (const summary of summaries) addUsage(auxiliaryCompactionUsage, summary.data?.usage, 'inputTokens')
  const allInUsage = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  addUsage(allInUsage, sessionUsage)
  addUsage(allInUsage, auxiliaryCompactionUsage)
  const promptTotal = allInUsage.uncachedInputTokens + allInUsage.cacheReadTokens + allInUsage.cacheWriteTokens

  const assistant = events.filter((event) => event.type === 'assistant/message')
  const finalTurn = Math.max(...assistant.map((event) => event.data?.turn).filter(Number.isFinite))
  const finalText = assistant.filter((event) => event.data?.turn === finalTurn)
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text).join('\n')
  const recalled = key.expected.filter(({ value }) => finalText.includes(value))
  const derived = Object.entries(key.derived).filter(([, value]) => finalText.includes(value))
  const meta = JSON.parse(readFileSync(join(evidence, 'run-meta.json'), 'utf8'))

  return {
    runId: basename(runDir),
    seed: key.seed,
    preset: meta.presetId,
    model: meta.model,
    sessionUsage,
    auxiliaryCompactionUsage,
    allInUsage,
    allInCacheReadFraction: promptTotal === 0 ? null : allInUsage.cacheReadTokens / promptTotal,
    finalContextPressure: lastProjection('contextPressure'),
    exactFacts: {
      recalled: recalled.length,
      expected: key.expected.length,
      missingKeys: key.expected.filter(({ value }) => !finalText.includes(value)).map(({ key }) => key),
    },
    derived: {
      recalled: derived.length,
      expected: Object.keys(key.derived).length,
      missing: Object.entries(key.derived).filter(([, value]) => !finalText.includes(value)).map(([name]) => name),
    },
    compactions: summaries.map((event) => ({
      compactionId: event.data.compactionId,
      provider: event.data.provider ?? null,
      model: event.data.model ?? null,
      shadowedNodes: event.data.shadowedSeqs?.length ?? 0,
      shadowedTokenCount: event.data.shadowedTokenCount ?? null,
      summaryChars: event.data.summary?.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) ?? 0,
      usage: event.data.usage ?? null,
      llmStreamCall: event.data.llmStreamCall ?? null,
    })),
    errors: events.filter((event) => /(?:error|failed)$/.test(event.type)).map((event) => event.type),
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  evidenceRule: 'allInUsage = DSH session tokenUsage + provider-returned compaction/summary usage; no price conversion',
  runs: runDirs.map(analyze),
}
const out = resolve(process.env.OUTPUT ?? 'work/context-governor-research/randomized-paired-results.json')
writeFileSync(out, JSON.stringify(output, null, 2) + '\n')
console.log(out)
console.log(JSON.stringify(output, null, 2))
