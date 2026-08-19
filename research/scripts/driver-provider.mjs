#!/usr/bin/env node
/**
 * DSH Router Standard × ACP 对照实验驱动脚本。
 *
 * 通过 DSH Web 的 /api 网关(HTTP POST + events.mux WebSocket)以与 GUI
 * 完全相同的通道创建会话、选择预设/模型/推理强度、按固定脚本发送五条
 * 阶段消息,并记录全部证据。
 *
 * 用法: node driver.mjs <runId> <presetId> <group>   (group: control | acp)
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'

const BASE = process.argv[5] ? `http://127.0.0.1:${process.argv[5]}` : 'http://127.0.0.1:3080'
const BENCH = process.env.BENCH ?? resolve(process.cwd(), 'router-acp-benchmark')
const FIXTURE = fixtureDirParam()
function fixtureDirParam() {
  return process.argv[7] ? (process.argv[7].startsWith('/') ? process.argv[7] : join(BENCH, process.argv[7])) : join(BENCH, 'fixture')
}
const ARTIFACTS = join(BENCH, 'artifacts')

const runId = process.argv[2]
const presetId = process.argv[3]
const group = process.argv[4] // control | acp | nocomp | basic
const port = process.argv[5] // default 3080
const stagesFile = process.argv[6] // default artifacts/stages.json
const fixtureDir = process.argv[7] // default BENCH/fixture
const MODEL = process.argv[8] ?? 'deepseek-v4-flash'
const PROVIDER = process.argv[9] ?? 'deepseek-official'
if (!runId || !presetId || !group) {
  console.error('usage: node driver.mjs <runId> <presetId> <group> [port] [stagesFile] [fixtureDir]')
  process.exit(2)
}

const runDir = join(BENCH, 'runs', runId)
const evDir = join(runDir, '__evidence__')
mkdirSync(evDir, { recursive: true })
const muxLog = join(evDir, 'mux-events.jsonl')
const runMeta = { runId, presetId, group, startedAt: new Date().toISOString() }

function log(...a) {
  console.log(`[${new Date().toISOString()}]`, ...a)
}

async function api(method, payload, { timeoutMs } = {}) {
  const rpcId = randomUUID()
  const body = { type: 'client-request', rpcId, method, payload }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs ?? 30_000)
  try {
    const res = await fetch(`${BASE}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ── 1. 干净副本 ─────────────────────────────────────────────────────────────
if (existsSync(runDir)) {
  rmSync(runDir, { recursive: true, force: true })
  log(`cleared existing ${runDir}`)
}
mkdirSync(runDir, { recursive: true })
cpSync(FIXTURE, runDir, { recursive: true })
mkdirSync(evDir, { recursive: true })
log(`fixture copied to ${runDir}`)

// ── 2. events.mux 下行监听(证据 + 审批/提问自动回应) ─────────────────────
// 注意:必须在 session.create 之前打开——后开的连接收不到既有/并行会话的
// 实时事件(第二阶段实测);并带断线重连。
let ws
let eventCount = 0
let lastEventAt = Date.now()

function openMux() {
  return new Promise((res, rej) => {
    const sock = new WebSocket(`ws://127.0.0.1:${process.argv[5] ?? '3080'}/api/events.mux`, { origin: BASE })
    const done = setTimeout(() => rej(new Error('mux ws timeout')), 15_000)
    sock.onopen = () => { clearTimeout(done); res(sock) }
    sock.onerror = (e) => { clearTimeout(done); rej(new Error('mux ws error')) }
  })
}

async function ensureMux() {
  for (let attempt = 1; ; attempt++) {
    try {
      ws = await openMux()
      break
    } catch (e) {
      if (attempt >= 3) throw e
      log(`mux ws open failed (attempt ${attempt}), retrying...`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  ws.addEventListener('close', () => log('WARN: mux ws CLOSED — evidence stream lost for subsequent events'))
  ws.addEventListener('message', (msg) => handleMuxMessage(msg).catch((e) => log('mux handler error:', e.message)))
  log('events.mux websocket open')
}

async function handleMuxMessage(msg) {
  let envelope
  try {
    envelope = JSON.parse(msg.data)
  } catch {
    return
  }
  appendFileSync(muxLog, JSON.stringify({ at: new Date().toISOString(), ...envelope }) + '\n')
  const frame = envelope.payload ?? envelope
  const t = frame?.type ?? envelope?.type
  if (t === 'session/event') {
    eventCount += 1
    lastEventAt = Date.now()
  } else if (t === 'approval/requested') {
    log(`APPROVAL requested: ${frame.toolName} (approvalId=${frame.approvalId}) — auto-allow-once`)
    try {
      const r = await api('respond', {
        type: 'client-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'allowed-once' } },
      })
      log('APPROVAL respond receipt:', JSON.stringify(r))
    } catch (e) {
      log('APPROVAL respond FAILED:', e.message)
    }
  } else if (t === 'question/requested') {
    log(`QUESTION requested: ${JSON.stringify(frame).slice(0, 300)} — answering "continue"`)
    try {
      const answers = (frame.questions ?? []).map((q) => ({
        id: q.id,
        selected: [],
        custom: '按你的判断继续执行实验任务,无需向我确认。',
      }))
      const r = await api('respond', {
        type: 'client-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value: { sessionId: frame.sessionId, answer: { answers } } },
      })
      log('QUESTION respond receipt:', JSON.stringify(r))
    } catch (e) {
      log('QUESTION respond FAILED:', e.message)
    }
  } else if (t && t !== 'session/subscribed') {
    lastEventAt = Date.now()
  }
}

await ensureMux()

// ── 3. 会话创建与配置 ────────────────────────────────────────────────────────
const created = await api('session.create', { cwd: runDir, agentPreset: presetId }, { timeoutMs: 120_000 })
if (!created.result.ok) {
  throw new Error(`session.create failed: ${JSON.stringify(created.result)}`)
}
const sessionId = created.result.value.sessionId
runMeta.sessionId = sessionId
runMeta.createdPreset = created.result.value.agentPreset
log(`session created: ${sessionId} (preset=${created.result.value.agentPreset})`)

const modelPick = await api('session.selectModel', {
  sessionId,
  provider: PROVIDER,
  model: MODEL,
  reasoningEffort: 'max',
})
if (!modelPick.result.ok) {
  throw new Error(`selectModel failed: ${JSON.stringify(modelPick)}`)
}
runMeta.model = modelPick.result.value.selected
log(`model selected: ${JSON.stringify(modelPick.result.value.selected)}`)

// ── 4. 运行五个阶段 ─────────────────────────────────────────────────────────
const stagesDoc = JSON.parse(readFileSync(stagesFile ? (stagesFile.startsWith('/') ? stagesFile : join(BENCH, stagesFile)) : join(ARTIFACTS, 'stages.json'), 'utf8'))
const stagesPathUsed = stagesFile ?? 'artifacts/stages.json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getSummary() {
  const l = await api('session.list', {})
  return l.result?.value?.items?.find?.((x) => x.sessionId === sessionId)
}

async function isRunning() {
  return (await getSummary())?.running ?? false
}

async function waitIdle(stageLabel, maxMs) {
  // 等 turn 开始再等结束;随后再加 20s 静默确认
  const t0 = Date.now()
  let sawRunning = false
  let quiet = 0
  while (Date.now() - t0 < maxMs) {
    const running = await isRunning()
    if (running) sawRunning = true
    if (sawRunning && !running) {
      quiet += 5
      if (quiet >= 4) return { ok: true, elapsedMs: Date.now() - t0 }
    } else {
      quiet = 0
    }
    const idleMinutes = (Date.now() - lastEventAt) / 60_000
    if (sawRunning && idleMinutes > 10) {
      log(`WARN ${stageLabel}: no mux events for ${idleMinutes.toFixed(1)} min but still running`)
    }
    await sleep(5_000)
  }
  return { ok: false, elapsedMs: Date.now() - t0 }
}

const stageRecords = []
for (const stage of stagesDoc.stages) {
  const text = stage.text.replaceAll('{WORKSPACE}', runDir)
  const promptStart = Date.now()
  const pr = await api('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, { timeoutMs: 60_000 })
  if (!pr.result.ok) throw new Error(`prompt stage ${stage.id} failed: ${JSON.stringify(pr.result)}`)
  log(`stage ${stage.id} prompted; waiting for turn to finish...`)
  const w = await waitIdle(`stage${stage.id}`, 90 * 60_000)
  const rec = {
    stage: stage.id,
    promptedAt: new Date(promptStart).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - promptStart,
    eventCountAtEnd: eventCount,
    idleOk: w.ok,
    projectionsAfter: (await getSummary())?.projections ?? null,
  }
  stageRecords.push(rec)
  log(`stage ${stage.id} done in ${(rec.elapsedMs / 60000).toFixed(1)} min (idleOk=${w.ok}, events=${eventCount})`)
  if (!w.ok) {
    log(`stage ${stage.id} DID NOT settle; continuing anyway`)
  }
  await sleep(3_000)
}

// ── 5. 收尾状态提问(对照组/实验组对称) ──────────────────────────────────
const fqStart = Date.now()
const fq = await api('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: stagesDoc.finalQuestion[group] ?? stagesDoc.finalQuestion.control }],
}, { timeoutMs: 60_000 })
if (fq.result.ok) {
  await waitIdle('finalQuestion', 15 * 60_000)
  log(`final question done in ${((Date.now() - fqStart) / 60000).toFixed(1)} min`)
} else {
  log('final question prompt failed:', JSON.stringify(fq.result))
}

// ── 6. 证据落盘 ─────────────────────────────────────────────────────────────
await sleep(2_000)
const hist = await api('session.history', { sessionId, maxMessages: 500 }, { timeoutMs: 60_000 })
writeFileSync(join(evDir, 'session-history.json'), JSON.stringify(hist, null, 1))

const expRes = await fetch(`${BASE}/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`, {
  headers: { accept: 'application/json' },
})
if (expRes.ok) {
  const buf = Buffer.from(await expRes.arrayBuffer())
  writeFileSync(join(evDir, 'session-export.bin'), buf)
  log(`session export saved: ${buf.length} bytes (${expRes.headers.get('content-type')})`)
} else {
  log(`session.export failed: HTTP ${expRes.status}`)
}

runMeta.finishedAt = new Date().toISOString()
runMeta.stageRecords = stageRecords
runMeta.totalMuxSessionEvents = eventCount
runMeta.apiBase = BASE
runMeta.stagesFile = stagesPathUsed
runMeta.fixture = FIXTURE
runMeta.model = MODEL
writeFileSync(join(evDir, 'run-meta.json'), JSON.stringify(runMeta, null, 1))
log(`run ${runId} COMPLETE (via ${BASE})`)
ws.close()
process.exit(0)
