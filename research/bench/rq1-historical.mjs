#!/usr/bin/env node
/**
 * RQ1 closure (task B) — historical task suites on the bench driver.
 *
 * Ports the two recorded paired experiments onto research/bench (driver +
 * ledger + suite scoring) so RQ1's original falsifier can be tested: can the
 * bench reproduce the already-recorded paired results within noise?
 *
 *   code     suite: fixtures/code-engineering-holdout/code-seed-02 — four
 *            tool-driven implementation stages (real fixture repo, node --test
 *            oracle) + a no-tool final probe over 24 exact proofs + 4 derived
 *            concatenations. Historical arms (deepseek-v4-flash): Governor
 *            24/24+4/4 vs Basic-early all-in 6/24+0/4, total prompt −22.11%.
 *   semantic suite: fixtures/semantic-supersession/semantic-seed-01 — four
 *            no-tool Chinese minutes stages (unlabelled supersession) + a
 *            final current-state/rationale/obsolete probe. Historical arms
 *            (GLM-5.2): 12/12+10/10 tie, ARC uncached input −25.57%.
 *
 * Arms are driven one at a time against the isolated web host; the operator
 * flips the profile between arms (ARC installed + governor patch for `arc`;
 * plugin removed + `basic-early` preset for `basic` — see docs). All-in cost
 * accounting adds the provider-returned usage of every compaction/summary
 * event (the hidden summarizer calls) to the session-loop totals, exactly like
 * the recorded Basic arms.
 *
 *   node research/bench/rq1-historical.mjs offline
 *   node research/bench/rq1-historical.mjs live --suite code --arm arc
 *   node research/bench/rq1-historical.mjs consolidate
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient as baseMakeClient } from './driver.mjs'

/** Bench client with the raw respond() channel the approval auto-responder needs. */
function makeClient(baseUrl) {
  const base = baseMakeClient(baseUrl)
  return {
    call: base.call,
    respond(rpcId, value) {
      fetch(`${baseUrl}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
      }).catch(() => {})
    },
  }
}

const research = fileURLToPath(new URL('..', import.meta.url))
const BASE_URL = process.env.RQ1_URL ?? 'http://127.0.0.1:8933'
const OUT_DIR = resolve(process.env.RQ1_OUT ?? 'research/results/bench')
const WORK_ROOT = process.env.RQ1_WORK ?? '/tmp/rq1-hist'
const BUDGETS = { code: Number(process.env.RQ1_CODE_BUDGET ?? 45), semantic: Number(process.env.RQ1_SEM_BUDGET ?? 15) }
const STAGE_TIMEOUT_MS = Number(process.env.RQ1_STAGE_TIMEOUT_MS ?? 40 * 60 * 1000)

const SUITES = {
  code: {
    fixtureDir: join(research, 'fixtures', 'code-engineering-holdout', 'code-seed-02'),
    model: { provider: process.env.RQ1_CODE_PROVIDER ?? 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    preset: { arc: 'standard', basic: 'basic-early' },
  },
  semantic: {
    fixtureDir: join(research, 'fixtures', 'semantic-supersession', 'semantic-seed-01'),
    model: { provider: 'scnet', model: 'GLM-5.2', reasoningEffort: 'max' },
    preset: { arc: 'standard', basic: 'basic-early' },
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── suite scoring (ported 1:1 from the historical analyze scripts) ─────────

function matchesCriteria(text, groups) {
  return groups.every((alternatives) => alternatives.some((value) => text.includes(value)))
}

function scoreCodeSuite(key, finalText) {
  const recalled = key.expected.filter(({ value }) => finalText.includes(value))
  const derived = Object.entries(key.derived).filter(([, value]) => finalText.includes(value))
  return {
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
  }
}

function scoreSemanticSuite(key, finalText) {
  const currentHits = key.expected.filter(([name, value]) => key.currentCriteria?.[name]
    ? matchesCriteria(finalText, key.currentCriteria[name])
    : finalText.includes(value))
  const criteria = key.reasonCriteria ?? key.reasons.map((value) => [[value]])
  const reasonHits = criteria.filter((c) => matchesCriteria(finalText, c))
  const obsoleteLeaks = key.obsolete.filter((value) => finalText.replace(/\s+/g, '').includes(value.replace(/\s+/g, '')))
  return {
    currentState: {
      recalled: currentHits.length,
      expected: key.expected.length,
      missing: key.expected.filter(([name, value]) => key.currentCriteria?.[name]
        ? !matchesCriteria(finalText, key.currentCriteria[name])
        : !finalText.includes(value)).map(([name]) => name),
    },
    rationale: {
      recalled: reasonHits.length,
      expected: key.reasons.length,
      missing: criteria.map((c, i) => ({ c, label: key.reasons[i] })).filter(({ c }) => !matchesCriteria(finalText, c)).map(({ label }) => label),
    },
    obsoleteContamination: { count: obsoleteLeaks.length, leakedPatterns: obsoleteLeaks },
  }
}

// ── event-log analysis ──────────────────────────────────────────────────────

const summaryTextOf = (summary) => Array.isArray(summary)
  ? summary.filter((b) => b?.type === 'text').map((b) => b.text).join('')
  : String(summary ?? '')

function analyze(events, suite, key, workspace) {
  const assistant = events.filter((e) => e.type === 'assistant/message')
  const withUsage = assistant.filter((e) => (e.data ?? {}).usage)
  const finalTurn = Math.max(0, ...withUsage.map((e) => e.data.turn ?? 0))
  const finalText = assistant.filter((e) => (e.data?.turn ?? -1) === finalTurn)
    .flatMap((e) => e.data?.message?.content ?? [])
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n')

  let uncachedInputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  for (const e of withUsage) {
    const u = e.data.usage
    uncachedInputTokens += u.uncachedInputTokens ?? u.inputTokens ?? 0
    outputTokens += u.outputTokens ?? 0
    cacheReadTokens += u.cacheReadTokens ?? 0
  }
  const compactions = []
  let summarizerUncached = 0
  let summarizerOutput = 0
  let summarizerCacheRead = 0
  for (const e of events) {
    if (e.type !== 'compaction/summary') continue
    const d = e.data ?? {}
    const text = summaryTextOf(d.summary)
    const u = d.usage
    if (u) {
      summarizerUncached += u.inputTokens ?? 0
      summarizerOutput += u.outputTokens ?? 0
      summarizerCacheRead += u.cacheReadTokens ?? 0
    }
    compactions.push({
      provider: d.provider ?? null,
      model: d.model ?? null,
      shadowedNodes: d.shadowedSeqs?.length ?? 0,
      shadowedTokenCount: d.shadowedTokenCount ?? null,
      summaryChars: text.length,
      usage: u ? { uncachedInputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cacheReadTokens ?? 0 } : null,
    })
  }
  const headers = events.filter((e) => e.type === 'request/header')
  let projectTests = null
  if (suite === 'code') {
    try {
      const out = execFileSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 120000 })
      projectTests = { passed: true, tail: out.slice(-600) }
    } catch (error) {
      projectTests = { passed: false, tail: `${error.stdout ?? ''}${error.stderr ?? ''}`.slice(-600) }
    }
  }
  const sessionLoop = { uncachedInputTokens, outputTokens, cacheReadTokens, totalPromptTokens: uncachedInputTokens + cacheReadTokens }
  const allIn = {
    uncachedInputTokens: uncachedInputTokens + summarizerUncached,
    outputTokens: outputTokens + summarizerOutput,
    cacheReadTokens: cacheReadTokens + summarizerCacheRead,
  }
  allIn.totalPromptTokens = allIn.uncachedInputTokens + allIn.cacheReadTokens
  return {
    scoring: suite === 'code' ? scoreCodeSuite(key, finalText) : scoreSemanticSuite(key, finalText),
    sessionUsage: sessionLoop,
    allInUsage: allIn,
    compactions,
    requestHeaders: {
      count: headers.length,
      maxTokens: [...new Set(headers.map((e) => e.data?.header?.config?.maxTokens))],
      adapterDefaultMaxTokens: headers.filter((e) => e.data?.header?.adapterDefaults?.maxTokens === true).length,
    },
    modelCalls: withUsage.length,
    toolCallNames: Object.fromEntries([...new Set(events.filter((e) => e.type === 'tool/call').map((e) => e.data?.name))].map((name) => [name, events.filter((e) => e.type === 'tool/call' && e.data?.name === name).length])),
    projectTests,
    errors: events.filter((e) => /(?:error|failed)$/.test(e.type)).map((e) => e.type),
    turnErrors: events
      .filter((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'error')
      .map((e) => ({ turn: e.data?.turn ?? null, code: e.data?.reason?.error?.code ?? null, message: e.data?.reason?.error?.message ?? null })),
    finalTextHead: finalText.slice(0, 400),
  }
}

// ── live driver ─────────────────────────────────────────────────────────────

function openMux(client) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/api/events.mux`, { origin: BASE_URL })
    const done = setTimeout(() => rej(new Error('mux ws timeout')), 15000)
    ws.onopen = () => { clearTimeout(done); res(ws) }
    ws.onerror = () => { clearTimeout(done); rej(new Error('mux ws error')) }
  })
}

/** Auto-respond to approvals/questions exactly like the historical driver. */
function attachAutoResponder(ws, client) {
  ws.addEventListener('message', (msg) => {
    let envelope
    try {
      envelope = JSON.parse(msg.data)
    } catch {
      return
    }
    const frame = envelope.payload ?? envelope
    const t = frame?.type ?? envelope?.type
    if (t === 'approval/requested') {
      client.respond(envelope.rpcId, { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'allowed-once' })
    } else if (t === 'question/requested') {
      client.respond(envelope.rpcId, {
        sessionId: frame.sessionId,
        answer: { answers: (frame.questions ?? []).map((q) => ({ id: q.id, selected: [], custom: '按你的判断继续执行实验任务,无需向我确认。' })) },
      })
    }
  })
}

async function runLive(suiteName, arm) {
  const suite = SUITES[suiteName]
  const stagesDoc = JSON.parse(readFileSync(join(suite.fixtureDir, 'stages.json'), 'utf8'))
  const key = JSON.parse(readFileSync(join(suite.fixtureDir, 'answer-key.json'), 'utf8'))
  const workspace = join(WORK_ROOT, `${suiteName}-${arm}`)
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  if (existsSync(join(suite.fixtureDir, 'fixture'))) cpSync(join(suite.fixtureDir, 'fixture'), workspace, { recursive: true })
  else writeFileSync(join(workspace, 'README.md'), `# ${suiteName} ${arm} arm workspace (bench)\n`)

  const client = makeClient(BASE_URL)
  const ws = await openMux(client)
  attachAutoResponder(ws, client)

  const created = await client.call('session.create', { cwd: workspace, agentPreset: suite.preset[arm] })
  const sessionId = created.sessionId
  await client.call('session.selectModel', { sessionId, ...suite.model })

  const stageRecords = []
  let used = 0
  async function waitIdle(label) {
    let saw = false
    const t0 = Date.now()
    for (;;) {
      await sleep(5000)
      const list = await client.call('session.list', {})
      const me = list.items.find((i) => i.sessionId === sessionId)
      if (me?.running === true) saw = true
      // Grace: a turn that errored within one poll interval (e.g. a provider
      // transport blip) never shows running=true — stop waiting once a turn
      // had 90s to start.
      else if (saw || Date.now() - t0 > 90_000) break
      if (Date.now() - t0 > STAGE_TIMEOUT_MS) return { ok: false, label }
    }
    return { ok: true, label }
  }
  async function countCalls() {
    const h = await client.call('session.history', { sessionId, maxMessages: 100000 })
    return h.events.map((e) => e.event ?? e).filter((e) => e.type === 'assistant/message' && (e.data ?? {}).usage).length
  }
  async function pressure() {
    const h = await client.call('session.history', { sessionId, maxMessages: 1 })
    return h.projections?.values?.contextPressure ?? {}
  }

  for (const stage of stagesDoc.stages) {
    if (used >= BUDGETS[suiteName]) {
      stageRecords.push({ stage: stage.id, skipped: 'budget' })
      continue
    }
    await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: stage.text }] })
    const settle = await waitIdle(`stage-${stage.id}`)
    used = await countCalls()
    const p = await pressure()
    stageRecords.push({ stage: stage.id, settleOk: settle.ok, modelCalls: used, projectedTokens: p.projectedTokens ?? null })
  }
  const finalQuestion = stagesDoc.finalQuestion.control
  await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: finalQuestion }] })
  await waitIdle('final')
  used = await countCalls()

  const hist = await client.call('session.history', { sessionId, maxMessages: 100000 })
  const events = hist.events.map((e) => e.event ?? e)
  const analysis = analyze(events, suiteName, key, workspace)
  const report = {
    mode: 'live', suite: suiteName, arm, generatedAt: new Date().toISOString(),
    setup: {
      model: suite.model,
      agentPreset: suite.preset[arm],
      workspaceBasename: workspace.split('/').pop(),
      profileState: arm === 'arc' ? 'ARC 0.2.0-beta.5 installed; governor patch on compaction-arc-bridge' : 'ARC removed; basic-early preset (thresholdRatio 0.08, retainRatio 0.016)',
      budgetCap: BUDGETS[suiteName],
    },
    sessionId,
    stageRecords,
    ...analysis,
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = report.generatedAt.replace(/[:.]/g, '-')
  const file = join(OUT_DIR, `rq1-hist-${suiteName}-${arm}-${stamp}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  ws.close()
  console.log(JSON.stringify({ file, suite: suiteName, arm, quality: report.scoring, allIn: report.allInUsage, modelCalls: report.modelCalls, compactions: report.compactions.length, projectTests: report.projectTests?.passed ?? null }, null, 2))
}

// ── consolidation + verdicts ────────────────────────────────────────────────

const RECORDED = {
  code: {
    arc: { exact: 24, derived: 4, expected: 24, derivedExpected: 4, uncached: 121146, output: 23234, cacheRead: 934656 },
    basic: { exact: 6, derived: 0, expected: 24, derivedExpected: 4, uncached: 231315, output: 30940, cacheRead: 1124224 },
    recordedDeltas: { uncachedPct: -47.63, outputPct: -24.91, cacheReadPct: -16.86, totalPromptPct: -22.11 },
  },
  semantic: {
    arc: { current: 12, rationale: 10, expected: 12, rationaleExpected: 10, obsoleteLeaks: 0, uncached: 179616, output: 8625, cacheRead: 78848 },
    basic: { current: 12, rationale: 10, expected: 12, rationaleExpected: 10, obsoleteLeaks: 0, uncached: 241319, output: 11059, cacheRead: 80384 },
    recordedDeltas: { uncachedPct: -25.57, outputPct: -22.01, cacheReadPct: -1.91, totalPromptPct: -19.66 },
  },
}

function latestReport(suite, arm) {
  const candidates = readdirSync(OUT_DIR).filter((f) => new RegExp(`^rq1-hist-${suite}-${arm}-.*\\.json$`).test(f)).sort()
  if (candidates.length === 0) throw new Error(`no bench report for ${suite}/${arm}`)
  return { file: candidates[candidates.length - 1], report: JSON.parse(readFileSync(join(OUT_DIR, candidates[candidates.length - 1]), 'utf8')) }
}

function consolidate() {
  const out = { generatedAt: new Date().toISOString(), question: 'RQ1 closure: reproduce the recorded historical paired results on the bench driver within noise (quality within 1 fact; cost deltas direction-consistent and within ±10pp of the recorded values)' }
  const arms = {}
  for (const suite of ['code', 'semantic']) {
    for (const arm of ['arc', 'basic']) {
      const { file, report } = latestReport(suite, arm)
      arms[`${suite}-${arm}`] = { file, quality: report.scoring, allIn: report.allInUsage, sessionLoop: report.sessionUsage, modelCalls: report.modelCalls, compactions: report.compactions, projectTests: report.projectTests, turnErrors: report.turnErrors ?? null }
    }
  }
  const deltaPct = (arc, basic, field) => Number((((arc[field] - basic[field]) / basic[field]) * 100).toFixed(2))
  const verdicts = {}
  {
    const deltas = {
      uncachedPct: deltaPct(arms['code-arc'].allIn, arms['code-basic'].allIn, 'uncachedInputTokens'),
      outputPct: deltaPct(arms['code-arc'].allIn, arms['code-basic'].allIn, 'outputTokens'),
      cacheReadPct: deltaPct(arms['code-arc'].allIn, arms['code-basic'].allIn, 'cacheReadTokens'),
      totalPromptPct: deltaPct(arms['code-arc'].allIn, arms['code-basic'].allIn, 'totalPromptTokens'),
    }
    const r = RECORDED.code
    const checks = {
      arcExactWithin1: Math.abs(arms['code-arc'].quality.exactProofs.recalled - r.arc.exact) <= 1,
      basicExactWithin1: Math.abs(arms['code-basic'].quality.exactProofs.recalled - r.basic.exact) <= 1,
      arcDerivedWithin1: Math.abs(arms['code-arc'].quality.derived.recalled - r.arc.derived) <= 1,
      basicDerivedWithin1: Math.abs(arms['code-basic'].quality.derived.recalled - r.basic.derived) <= 1,
      qualityDirection: arms['code-arc'].quality.exactProofs.recalled > arms['code-basic'].quality.exactProofs.recalled,
      uncachedDirection: deltas.uncachedPct < 0,
      totalPromptDirection: deltas.totalPromptPct < 0,
      uncachedWithin10pp: Math.abs(deltas.uncachedPct - r.recordedDeltas.uncachedPct) <= 10,
      totalPromptWithin10pp: Math.abs(deltas.totalPromptPct - r.recordedDeltas.totalPromptPct) <= 10,
    }
    verdicts.code = { deltas, recordedDeltas: r.recordedDeltas, checks, reproduced: Object.values(checks).every(Boolean) }
  }
  {
    const deltas = {
      uncachedPct: deltaPct(arms['semantic-arc'].allIn, arms['semantic-basic'].allIn, 'uncachedInputTokens'),
      outputPct: deltaPct(arms['semantic-arc'].allIn, arms['semantic-basic'].allIn, 'outputTokens'),
      cacheReadPct: deltaPct(arms['semantic-arc'].allIn, arms['semantic-basic'].allIn, 'cacheReadTokens'),
      totalPromptPct: deltaPct(arms['semantic-arc'].allIn, arms['semantic-basic'].allIn, 'totalPromptTokens'),
    }
    const r = RECORDED.semantic
    const checks = {
      arcCurrentWithin1: Math.abs(arms['semantic-arc'].quality.currentState.recalled - r.arc.current) <= 1,
      basicCurrentWithin1: Math.abs(arms['semantic-basic'].quality.currentState.recalled - r.basic.current) <= 1,
      arcRationaleWithin1: Math.abs(arms['semantic-arc'].quality.rationale.recalled - r.arc.rationale) <= 1,
      basicRationaleWithin1: Math.abs(arms['semantic-basic'].quality.rationale.recalled - r.basic.rationale) <= 1,
      qualityTie: Math.abs(arms['semantic-arc'].quality.currentState.recalled - arms['semantic-basic'].quality.currentState.recalled) <= 1,
      obsoleteZero: arms['semantic-arc'].quality.obsoleteContamination.count === 0 && arms['semantic-basic'].quality.obsoleteContamination.count === 0,
      uncachedDirection: deltas.uncachedPct < 0,
      uncachedWithin10pp: Math.abs(deltas.uncachedPct - r.recordedDeltas.uncachedPct) <= 10,
    }
    verdicts.semantic = { deltas, recordedDeltas: r.recordedDeltas, checks, reproduced: Object.values(checks).every(Boolean) }
  }
  out.arms = arms
  out.verdicts = verdicts
  // Finer verdict + difference localization (the commission's honest-reporting
  // rule: a flipped amplitude or direction is recorded, never massaged).
  for (const suite of ['code', 'semantic']) {
    const v = verdicts[suite]
    const failed = Object.entries(v.checks).filter(([, ok]) => !ok).map(([k]) => k)
    v.failedChecks = failed
    v.verdict = failed.length === 0 ? 'reproduced-within-noise'
      : failed.some((k) => k.endsWith('Direction') || k === 'qualityDirection') ? 'direction-flipped'
        : 'direction-reproduced-amplitude-or-tolerance-out-of-bounds'
  }
  out.differenceLocalization = {
    benchVsRecordedGeometry: [
      'agent preset: bench arms run the official rc.7 `standard` (arc, via bridge) and a byte-identical clone `basic-early` (basic) — the recorded arms ran the legacy router-standard family presets (different system prompts and tool surface)',
      'code-suite provider: opencode-go/deepseek-v4-flash with a 384000 adapter-default maxTokens (settings.yaml) — the recorded arms ran deepseek-official with a 256000 adapter default; both are adapter-filled defaults (no caller intent), but the reserve number differs',
      'session-shape variance is model-driven: same fixture bytes and prompts, but flash chose leaner/denser tool paths under the current preset, changing call counts, compaction placements, and summarizer cache luck',
      'per-arm anomalies are recorded in each bench report (turnErrors, settleOk flags, compaction provider metadata)',
    ],
    perArm: {},
  }
  for (const key of Object.keys(arms)) {
    const a = arms[key]
    out.differenceLocalization.perArm[key] = {
      modelCalls: a.modelCalls,
      compactions: a.compactions.length,
      compactionProviders: a.compactions.map((c) => `${c.provider}/${c.model}`),
      summarizerUsageAllIn: a.compactions.reduce((acc, c) => ({
        uncachedInputTokens: acc.uncachedInputTokens + (c.usage?.uncachedInputTokens ?? 0),
        outputTokens: acc.outputTokens + (c.usage?.outputTokens ?? 0),
        cacheReadTokens: acc.cacheReadTokens + (c.usage?.cacheReadTokens ?? 0),
      }), { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }),
      turnErrors: a.turnErrors ?? null,
    }
  }
  out.rq1Closure = {
    reproduced: verdicts.code.reproduced && verdicts.semantic.reproduced,
    note: 'within-noise definition per the commission: quality within 1 fact of each recorded value, cost delta direction-consistent and within ±10pp of the recorded amplitude',
  }
  const file = resolve(research, 'results', 'rq1-historical-reproduction.json')
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify({ file, verdicts, rq1Closure: out.rq1Closure }, null, 2))
}

// ── offline self-test ───────────────────────────────────────────────────────

function offline() {
  const checks = {}
  for (const [suiteName, suite] of Object.entries(SUITES)) {
    const key = JSON.parse(readFileSync(join(suite.fixtureDir, 'answer-key.json'), 'utf8'))
    const stagesDoc = JSON.parse(readFileSync(join(suite.fixtureDir, 'stages.json'), 'utf8'))
    checks[`${suiteName}-stages`] = stagesDoc.stages.length === 4
    checks[`${suiteName}-finalQuestion`] = typeof stagesDoc.finalQuestion.control === 'string' && stagesDoc.finalQuestion.control.length > 50
    if (suiteName === 'code') {
      checks['code-expected24'] = key.expected.length === 24
      checks['code-derived4'] = Object.keys(key.derived).length === 4
      const perfect = key.expected.map(({ value }) => value).join('\n') + '\n' + Object.values(key.derived).join('\n')
      const scored = scoreCodeSuite(key, perfect)
      checks['code-perfectCorpusFull'] = scored.exactProofs.recalled === 24 && scored.derived.recalled === 4
      // Remove EVERY occurrence (a proof value can legitimately survive a
      // single deletion via a derived concatenation — the same aliasing
      // property the historical scorer had).
      const dropped = scoreCodeSuite(key, perfect.split(key.expected[0].value).join('x'))
      checks['code-removalDetected'] = dropped.exactProofs.recalled === 23 && dropped.derived.recalled <= 3
      checks['code-fixtureRepo'] = existsSync(join(suite.fixtureDir, 'fixture', 'src', 'release-policy.js'))
    } else {
      checks['semantic-expected12'] = key.expected.length === 12
      checks['semantic-reasons10'] = key.reasons.length === 10
      checks['semantic-criteriaAligned'] = (key.currentCriteria ? Object.keys(key.currentCriteria).length : 0) === 12 && key.reasonCriteria.length === 10
      // Known-answer: the RECORDED historical GLM ARC final text must re-score
      // 12/12 + 10/10 + 0 obsolete under the ported scorer.
      const hist = JSON.parse(readFileSync(join(research, 'results', 'semantic-supersession-seed01-glm52-arc-v2-results.json'), 'utf8'))
      const rescored = scoreSemanticSuite(key, hist.finalText)
      checks['semantic-historicalTextReproduces'] = rescored.currentState.recalled === 12 && rescored.rationale.recalled === 10 && rescored.obsoleteContamination.count === 0
      const histBasic = JSON.parse(readFileSync(join(research, 'results', 'semantic-supersession-seed01-glm52-basic-results.json'), 'utf8'))
      const rescoredBasic = scoreSemanticSuite(key, histBasic.finalText)
      checks['semantic-historicalBasicTextReproduces'] = rescoredBasic.currentState.recalled === 12 && rescoredBasic.rationale.recalled === 10 && rescoredBasic.obsoleteContamination.count === 0
    }
  }
  const pass = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ mode: 'offline', checks, pass }, null, 2))
  process.exitCode = pass ? 0 : 1
}

const args = process.argv.slice(2)
const mode = args[0]
if (mode === 'offline') offline()
else if (mode === 'live') {
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1] }
  const suite = flag('suite')
  const arm = flag('arm')
  if (!SUITES[suite] || !['arc', 'basic'].includes(arm)) {
    console.error('usage: rq1-historical.mjs live --suite code|semantic --arm arc|basic')
    process.exit(2)
  }
  await runLive(suite, arm)
} else if (mode === 'consolidate') consolidate()
else {
  console.error('usage: rq1-historical.mjs <offline|live|consolidate>')
  process.exit(2)
}
