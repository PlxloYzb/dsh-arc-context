#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const sessionId = process.argv[2]
const runDir = process.argv[3]
const port = process.argv[4] ?? '3083'
if (!sessionId || !runDir) {
  console.error('usage: node continue-trigger-fallback.mjs SESSION_ID RUN_DIR [PORT]')
  process.exit(2)
}

const base = `http://127.0.0.1:${port}`
const evidence = join(runDir, '__evidence__')
const muxLog = join(evidence, 'mux-events-continuation-trigger-fallback.jsonl')

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

async function waitIdle(maxMs = 30 * 60_000) {
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
  throw new Error('fallback trigger did not become idle')
}

const promptedAt = new Date().toISOString()
const text = [
  '这是合成上下文 Governor 应急回退验证。',
  '先调用 acp_status。若已生成本地应急压缩块，请调用 search_context 搜索 GOV-FALLBACK；必要时再检索或解压，禁止外部数据源。',
  '然后逐字输出 S01 到 S15 的全部 BEGIN/MIDDLE/END 金丝雀（共 45 条，按阶段顺序），最后报告块数、压缩提供者/模型、回收 token 和上下文压力。',
].join('\n')
const prompt = await api('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text }],
})
if (!prompt.result?.ok) throw new Error(`trigger prompt failed: ${JSON.stringify(prompt)}`)
await waitIdle()

const history = await api('session.history', { sessionId, maxMessages: 500 })
writeFileSync(join(evidence, 'session-history-after-trigger-fallback.json'), JSON.stringify(history, null, 1))
writeFileSync(join(evidence, 'continuation-trigger-fallback-meta.json'), JSON.stringify({
  sessionId,
  promptedAt,
  finishedAt: new Date().toISOString(),
  projections: (await summary())?.projections ?? null,
}, null, 2))
ws.close()
console.log(`triggered fallback validation for ${sessionId}`)
