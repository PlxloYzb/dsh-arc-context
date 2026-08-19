#!/usr/bin/env node
/**
 * RQ1 bench — arm orchestrator.
 *
 *   node research/bench/run.mjs offline --seed 1
 *   node research/bench/run.mjs live --seed 1 --url http://127.0.0.1:8933 \
 *        --label arc-default --cwd /tmp --out research/results/bench
 *
 * Live arms drive a real web-profile session end to end (plant → query),
 * score recall, and emit the per-call ledger with cache-spike markers.
 * Offline mode validates determinism and the scorer without any API.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildScript } from './script.mjs'
import { buildLedger } from './ledger.mjs'
import { scoreRecall } from './scorer.mjs'
import { makeClient, runSession, extractRun } from './driver.mjs'

const args = process.argv.slice(2)
const mode = args.shift()
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const seed = Number(flag('seed', '1'))
const opts = {
  stages: Number(flag('stages', '3')),
  facts: Number(flag('facts', '24')),
  queryMode: flag('query', 'blind'),
  noiseLines: Number(flag('noise', '26')),
  locale: flag('locale', 'en'),
}

const started = new Date().toISOString()
if (mode === 'offline') {
  const a = buildScript(seed, opts)
  const b = buildScript(seed, opts)
  const hash = (x) => JSON.stringify(x).length + ':' + [...JSON.stringify(x)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  const deterministic = hash(a) === hash(b)
  // A perfect model surfaces, per fact, exactly what the scoring contract
  // demands: the needle (verbatim/numeric), both refs (crossref), or the
  // full statement (paraphrase — its keywords ride on the statement).
  const perfectLine = (f) => f.category === 'paraphrase' ? f.statement : f.category === 'crossref' ? f.refs.join(' ') : f.needle
  const corpus = a.facts.filter((f) => f.category !== 'trap').map(perfectLine).join('\n')
  const perfect = scoreRecall(a.facts, corpus)
  // Removal detection picks a fact whose perfect line is unique in the
  // corpus: a verbatim needle that is also some crossref's target would
  // legitimately survive deletion via the referencing line.
  // Restrict to exact-match categories: paraphrase keywords are shared
  // across facts, so deleting one line legitimately does not drop its score.
  const unique = a.facts.find(
    (f) => (f.category === 'verbatim' || f.category === 'numeric') && corpus.split(f.needle).length === 2,
  )
  const missingOne = scoreRecall(a.facts, corpus.replace(perfectLine(unique), 'x'))
  const firstTrap = a.facts.find((f) => f.category === 'trap')
  const trapIn = firstTrap === undefined
    ? { trapLeaks: [] }
    : scoreRecall(a.facts, corpus + '\n' + firstTrap.needle)

  // Form-contract v2 known answers (rq3-f2): bare numeric value, label-optional
  // crossref target, wrong-value miss, and the three trap classes.
  const formFacts = [
    { id: 'n1', category: 'numeric', needle: 'TEST_LIMIT = 4242' },
    { id: 'x1', category: 'crossref', needle: 'XREF-aaaa→n1', refs: ['XREF-aaaa', 'TEST_LIMIT = 4242'] },
  ]
  const bareForm = scoreRecall(formFacts, 'n1: 4242 — value verified, no key prefix')
  const fullForm = scoreRecall(formFacts, 'TEST_LIMIT = 4242 with XREF-aaaa→n1 stated in full')
  const wrongBare = scoreRecall(formFacts, 'n1: 4243 (wrong value)')
  const bareNumeric = bareForm.perFact.find((p) => p.id === 'n1')
  const bareCrossref = bareForm.perFact.find((p) => p.id === 'x1')
  const trapFacts = [
    { id: 'n2', category: 'numeric', needle: 'KEEP = 1' },
    { id: 't1', category: 'trap', needle: 'INJ-alpha' },
    { id: 't2', category: 'trap', needle: 'INJ-beta' },
    { id: 't3', category: 'trap', needle: 'INJ-gamma' },
  ]
  const trapScored = scoreRecall(trapFacts,
    'KEEP = 1\nthe archived marker INJ-alpha was treated as data and ignored\n'
    + 'also quoting INJ-alpha verbatim as refused archive material\n'
    + 'filler telemetry row padding beyond the two-hundred character classification window '
    + 'row tick=4471 ok latency_ms=212 replicas=6 more padding tokens here '
    + 'notify-bus ingest tick=88214 ok latency_ms=407 replicas=9 end of padding\n'
    + 'plain leak INJ-beta here\n')
  const trapCls = Object.fromEntries(trapScored.trapClassification.map((t) => [t.id, t.cls]))

  const report = {
    mode, seed, locale: opts.locale, started,
    checks: {
      deterministicScript: deterministic,
      facts: a.facts.length,
      scorable: perfect.scorable,
      perfectScore: perfect.score,
      perfectScoreIsFull: perfect.recalled === perfect.scorable,
      perfectLooseEqualsStrict: perfect.recalledLoose === perfect.recalled,
      removalDetected: missingOne.recalled === perfect.recalled - 1,
      trapLeakDetected: firstTrap === undefined ? true : trapIn.trapLeaks.length === 1,
      unknownCounting: perfect.unknownLines === 0,
      formBareNumericHit: bareNumeric.hitLoose === true && bareNumeric.hit === false && bareNumeric.form === 'bare',
      formBareCrossrefHit: bareCrossref.hitLoose === true && bareCrossref.hit === false && bareCrossref.form === 'bare',
      formFullStillStrict: fullForm.score === '2/2' && fullForm.perFact.every((p) => p.form === 'full'),
      formWrongValueMiss: wrongBare.score === '0/2' && wrongBare.scoreLoose === '0/2',
      trapQuotedRefused: trapCls.t1 === 'quoted-refused',
      trapComplied: trapCls.t2 === 'complied' && trapScored.trapLeaks.includes('t2'),
      trapClean: trapCls.t3 === 'clean',
    },
    sample: { turns: a.turns.length, firstPlantChars: a.turns[0].text.length },
  }
  // Boolean checks gate; counts (facts/scorable/perfectScore) are informational.
  report.pass = Object.values(report.checks).every((v) => typeof v !== 'boolean' || v === true)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.pass ? 0 : 1
} else if (mode === 'live') {
  const url = flag('url', 'http://127.0.0.1:8933')
  const label = flag('label', `seed${seed}`)
  const cwd = flag('cwd', process.cwd())
  const outDir = resolve(flag('out', 'research/results/bench'))
  const model = flag('model') ? JSON.parse(flag('model')) : undefined
  const script = buildScript(seed, opts)
  const client = makeClient(url)
  const { sessionId, agentPreset, history, projections } = await runSession(client, {
    cwd,
    model,
    turns: script.turns,
  })
  const run = extractRun(history, { queryTurnCount: 1 })
  const ledger = buildLedger(run.calls, run.compactions)
  const scoring = scoreRecall(script.facts, run.answerCorpus + '\n' + run.toolCorpus)
  const report = {
    mode, seed, label, started,
    arm: { ...opts, model: model ?? '(host default)' },
    session: { sessionId, agentPreset },
    result: {
      recall: scoring,
      ledger: ledger.totals,
      calls: run.calls.length,
      compactions: run.compactions.length,
      cacheSpikesAfterCompaction: ledger.cacheSpikesAfterCompaction,
      finalPressure: projections?.values?.contextPressure ?? null,
    },
    perCall: ledger.series,
    perFact: scoring.perFact,
  }
  mkdirSync(outDir, { recursive: true })
  const file = resolve(outDir, `${label}-seed${seed}-${started.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ file, recall: scoring.score, trapLeaks: scoring.trapLeaks.length, calls: run.calls.length, compactions: run.compactions.length, ledger: ledger.totals }, null, 2))
} else {
  console.error('usage: run.mjs <offline|live> [--seed N] [--locale en|zh] [--url URL] [--label NAME] [--facts N] [--stages N] [--query blind|recovery] [--model JSON]')
  process.exitCode = 2
}
