#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const sessionId = process.argv[2]
const runDir = process.argv[3]
const stagesPath = process.argv[4]
const stageId = Number(process.argv[5])
const port = process.argv[6] ?? '3083'
if (!sessionId || !runDir || !stagesPath || !Number.isSafeInteger(stageId)) {
  console.error('usage: node continue-synthetic-fallback.mjs SESSION_ID RUN_DIR STAGES_JSON STAGE_ID [PORT]')
  process.exit(2)
}

const base = `http://127.0.0.1:${port}`
const evidence = join(runDir, '__evidence__')
const muxLog = join(evidence, `mux-events-continuation-stage${stageId}.jsonl`)
const doc = JSON.parse(readFileSync(stagesPath, 'utf8'))
const stage = doc.stages.find((item) => item.id === stageId)
if (!stage) throw new Error(`stage ${stageId} not found`)

async function api(method, payload, timeoutMs = 60_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${method}`)
    return response.json()
  } finally {
    clearTimeout(timer)
  }
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`, { origin: base })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('mux open timeout')), 15_000)
  ws.onopen = () => { clearTimeout(timer); resolve() }
  ws.onerror = () => { clearTimeout(timer); reject(new Error('mux open failed')) }
})
ws.onmessage = (message) => appendFileSync(muxLog, `${message.data}\n`)

async function summary() {
  const response = await api('session.list', {})
  return response.result?.value?.items?.find((item) => item.sessionId === sessionId)
}

async function waitIdle(label, maxMs = 30 * 60_000) {
  const start = Date.now()
  let sawRunning = false
  let idlePolls = 0
  while (Date.now() - start < maxMs) {
    const running = (await summary())?.running ?? false
    if (running) sawRunning = true
    if (sawRunning && !running) {
      idlePolls += 1
      if (idlePolls >= 4) return
    } else {
      idlePolls = 0
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  throw new Error(`${label} did not become idle`)
}

const promptedAt = new Date().toISOString()
const prompt = await api('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: stage.text.replaceAll('{WORKSPACE}', runDir) }],
})
if (!prompt.result?.ok) throw new Error(`stage prompt failed: ${JSON.stringify(prompt)}`)
await waitIdle(`stage ${stageId}`)

const final = await api('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: doc.finalQuestion.acp }],
})
if (!final.result?.ok) throw new Error(`final prompt failed: ${JSON.stringify(final)}`)
await waitIdle('final recall')

const history = await api('session.history', { sessionId, maxMessages: 500 })
writeFileSync(join(evidence, `session-history-after-stage${stageId}.json`), JSON.stringify(history, null, 1))
writeFileSync(join(evidence, `continuation-stage${stageId}-meta.json`), JSON.stringify({
  sessionId,
  stageId,
  promptedAt,
  finishedAt: new Date().toISOString(),
  projections: (await summary())?.projections ?? null,
}, null, 2))
ws.close()
console.log(`continued ${sessionId} through stage ${stageId}`)
