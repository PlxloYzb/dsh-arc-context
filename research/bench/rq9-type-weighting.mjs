#!/usr/bin/env node
/**
 * RQ9 — type-weighted retention under appendix budget pressure (offline, zero API).
 *
 * Hypothesis (falsifiable): at constrained appendix budgets, assembling the
 * safety-index body by per-event information value retains strictly more
 * typed facts (verbatim/numeric/crossref/paraphrase) than the chronological
 * body + character cut, at identical budget.
 *
 * Deterministic corpora come from the shared bench generator; noise events are
 * high-frequency log templates (the production shape the rare-line filter and
 * head/tail previews already face). Layouts cover both an adversarial
 * facts-last ordering and the natural interleaved ordering.
 *
 * Usage:
 *   node --import tsx research/bench/rq9-type-weighting.mjs            # all policies
 *   node --import tsx research/bench/rq9-type-weighting.mjs chronological
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildScript } from './script.mjs'
import { scoreRecall } from './scorer.mjs'
import { buildModelSummarySafetyIndex } from '../../src/fallback.ts'

const OUT = resolve(process.env.RQ9_OUT ?? 'research/results/rq9-type-weighting-results.json')
const BUDGETS = [24_000, 16_000, 12_000, 8_000, 5_000, 3_000]
const SEEDS = [1, 2, 3]
const LAYOUTS = ['facts-last', 'interleaved']
const POLICIES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['chronological']

function fakeAgent(session) {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  }
}

function appendUserEvent(session, text) {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/** A ~1.1K-char event of one dominant log template with varying numbers. */
function noiseEvent(session, index, locale) {
  const rows = Array.from({ length: 24 }, (_, i) =>
    locale === 'zh'
      ? `例行采样 ${index}-${i}: 状态=正常 延迟毫秒=${(31 + i * 7 + index) % 997} 队列=${(i * 13 + index) % 211} 输出=已校验`
      : `routine sample ${index}-${i}: status=ok latency_ms=${(31 + i * 7 + index) % 997} queue=${(i * 13 + index) % 211} output=checked`)
  appendUserEvent(session, rows.join('\n'))
}

function buildSession(seed, locale, layout) {
  const script = buildScript(seed, { locale, stages: 3, facts: 30, noiseLines: 90, queryMode: 'blind' })
  const session = Session.create(`rq9-${locale}-${seed}-${layout}`)
  const plants = script.turns.filter((turn) => turn.kind === 'plant')
  if (layout === 'facts-last') {
    for (let i = 0; i < 60; i += 1) noiseEvent(session, i, locale)
    for (const turn of plants) appendUserEvent(session, turn.text)
  } else {
    plants.forEach((turn, index) => {
      appendUserEvent(session, turn.text)
      for (let i = 0; i < 20; i += 1) noiseEvent(session, index * 20 + i, locale)
    })
  }
  const seqs = session.events.filter((event) => event.type === 'user/message').map((event) => event.seq)
  return { session, script, seqs }
}

function measure(policy, seed, locale, layout, budget) {
  const { session, script, seqs } = buildSession(seed, locale, layout)
  const index = buildModelSummarySafetyIndex(fakeAgent(session), seqs, budget, policy)
  const recall = scoreRecall(script.facts, index, {}, { answerText: index })
  const byCategory = {}
  for (const fact of recall.perFact) {
    byCategory[fact.category] ??= { scorable: 0, strict: 0, loose: 0 }
    byCategory[fact.category].scorable += 1
    if (fact.hit) byCategory[fact.category].strict += 1
    if (fact.hitLoose) byCategory[fact.category].loose += 1
  }
  return { chars: index.length, strict: recall.recalled, loose: recall.recalledLoose, scorable: recall.scorable, byCategory }
}

const rows = []
for (const policy of POLICIES) {
  for (const layout of LAYOUTS) {
    for (const locale of ['en', 'zh']) {
      for (const seed of SEEDS) {
        for (const budget of BUDGETS) {
          rows.push({ policy, layout, locale, seed, budget, ...measure(policy, seed, locale, layout, budget) })
        }
      }
    }
  }
}

function aggregate(policy) {
  return BUDGETS.map((budget) => {
    const slice = rows.filter((row) => row.policy === policy && row.budget === budget)
    const sum = (pick) => slice.reduce((n, row) => n + pick(row), 0)
    const scorable = sum((row) => row.scorable)
    const categories = {}
    for (const row of slice) {
      for (const [category, counts] of Object.entries(row.byCategory)) {
        categories[category] ??= { scorable: 0, strict: 0, loose: 0 }
        categories[category].scorable += counts.scorable
        categories[category].strict += counts.strict
        categories[category].loose += counts.loose
      }
    }
    const byLayout = Object.fromEntries(['facts-last', 'interleaved'].map((layout) => {
      const lrows = slice.filter((row) => row.layout === layout)
      return [layout, {
        loose: `${lrows.reduce((n, r) => n + r.loose, 0)}/${lrows.reduce((n, r) => n + r.scorable, 0)}`,
        strict: `${lrows.reduce((n, r) => n + r.strict, 0)}/${lrows.reduce((n, r) => n + r.scorable, 0)}`,
      }]
    }))
    return {
      budget, strict: `${sum((r) => r.strict)}/${scorable}`, loose: `${sum((r) => r.loose)}/${scorable}`,
      looseRate: scorable === 0 ? null : sum((r) => r.loose) / scorable,
      strictRate: scorable === 0 ? null : sum((r) => r.strict) / scorable,
      byCategory: Object.fromEntries(Object.entries(categories).map(([category, counts]) => [category, `${counts.loose}/${counts.scorable}`])),
      byLayout,
    }
  })
}

const report = {
  schemaVersion: 1,
  rq: 'RQ9',
  generatedAt: new Date().toISOString(),
  mode: 'offline; deterministic; zero model calls',
  hypothesis: 'value-ranked body assembly retains more typed facts than chronological body + char cut at identical budgets',
  design: { budgets: BUDGETS, seeds: SEEDS, locales: ['en', 'zh'], layouts: LAYOUTS, corpus: 'buildScript(seed, stages:3, facts:30, noiseLines:90) + dominant-template noise events', scored: 'all non-trap facts, loose + strict calibers' },
  policies: Object.fromEntries(POLICIES.map((policy) => [policy, aggregate(policy)])),
  runs: rows,
}
mkdirSync(resolve(OUT, '..'), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ file: OUT, policies: Object.fromEntries(POLICIES.map((p) => [p, aggregate(p).map((row) => `${row.budget}:${row.loose}`)])) }, null, 2))
