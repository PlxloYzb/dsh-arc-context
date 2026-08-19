#!/usr/bin/env node
/**
 * RQ5b, zero-call audit of the four Governor-local checkpoints retained in
 * the first RQ5 run.  The source logs remain in the isolated DSH home and
 * are never copied into the repository.  This reads each compressed JSONL
 * stream, identifies the seeded facts in the archived surface nodes, and
 * applies the shared RQ1 form-contract scorer to the checkpoint text itself.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateFacts } from '../bench/facts.mjs'
import { scoreRecall } from '../bench/scorer.mjs'

const root = resolve(import.meta.dirname, '..')
const out = resolve(process.env.RQ5_GOVERNOR_AUDIT_OUT ?? root, 'results/rq5-governor-archive-audit.json')
const dshHome = process.env.RQ5_DSH_HOME ?? resolve(process.env.HOME ?? '', 'Workspace/dsh-extensions/verify/arc-live-rc7')
const seed = 505
const sessions = [
  { arm: 'G80', sessionId: 'session-83698664-c219-49e1-8df6-9e77a5f0ee9b' },
  { arm: 'G88', sessionId: 'session-0c9c9dd4-af64-4195-8313-8131b5fa6797' },
]

function shell(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function readEvents(sessionId) {
  const source = shell('find', [resolve(dshHome, 'sessions'), '-path', `*/${sessionId}/session.jsonl.zstd`])
  if (!source) throw new Error(`durable log not found for ${sessionId}`)
  const lines = shell('zstd', ['-q', '-d', '-c', source]).split('\n').filter(Boolean)
  return lines.map((line) => JSON.parse(line))
}

function textOf(blocks) {
  return (blocks ?? []).flatMap((block) => block?.content ?? [block])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

function factIdsIn(event) {
  return [...textOf(event.data?.content).matchAll(/\[f(\d+)\]/g)].map((match) => `f${match[1]}`)
}

const facts = generateFacts(seed, { facts: 24 }).filter((fact) => fact.category !== 'trap')
const factsById = new Map(facts.map((fact) => [fact.id, fact]))
const archives = []
for (const session of sessions) {
  const events = readEvents(session.sessionId)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  for (const event of events.filter((event) => event.type === 'compaction/summary' && event.data?.provider === 'local')) {
    const summaryText = textOf(event.data?.summary)
    const factIds = (event.data?.shadowedSeqs ?? []).flatMap((seq) => factIdsIn(bySeq.get(seq)))
    const archiveFacts = [...new Set(factIds)].map((id) => factsById.get(id)).filter(Boolean)
    if (archiveFacts.length === 0) throw new Error(`${session.arm} archive ${event.seq} has no planted facts`)
    const score = scoreRecall(archiveFacts, summaryText, {}, { answerText: summaryText })
    const perFact = score.perFact.map((record) => ({
      ...record,
      retention: record.hit ? 'verbatim' : record.hitLoose ? 'paraphrase' : 'lost',
    }))
    archives.push({
      arm: session.arm,
      sessionId: session.sessionId,
      checkpointSeq: event.seq,
      compactionId: event.data?.compactionId ?? null,
      shadowedRange: event.data?.shadowedRange ?? null,
      shadowedSeqs: event.data?.shadowedSeqs ?? [],
      shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
      summaryChars: summaryText.length,
      plantedFactIds: archiveFacts.map((fact) => fact.id),
      score: {
        strict: score.score,
        loose: score.scoreLoose,
        strictRate: score.recallRate,
        looseRate: score.recallRateLoose,
      },
      perFact,
      retention: {
        verbatim: perFact.filter((record) => record.retention === 'verbatim').length,
        paraphrase: perFact.filter((record) => record.retention === 'paraphrase').length,
        lost: perFact.filter((record) => record.retention === 'lost').length,
      },
    })
  }
}

const factRows = archives.flatMap((archive) => archive.perFact)
const categoryDistribution = Object.fromEntries([...new Set(factRows.map((row) => row.category))].sort().map((category) => {
  const rows = factRows.filter((row) => row.category === category)
  const count = (retention) => rows.filter((row) => row.retention === retention).length
  return [category, {
    total: rows.length,
    verbatim: count('verbatim'),
    paraphrase: count('paraphrase'),
    lost: count('lost'),
    strictRate: rows.filter((row) => row.hit).length / rows.length,
    looseRate: rows.filter((row) => row.hitLoose).length / rows.length,
  }]
}))
const totals = {
  facts: factRows.length,
  verbatim: factRows.filter((row) => row.retention === 'verbatim').length,
  paraphrase: factRows.filter((row) => row.retention === 'paraphrase').length,
  lost: factRows.filter((row) => row.retention === 'lost').length,
}
totals.strictRate = totals.verbatim / totals.facts
totals.looseRate = (totals.verbatim + totals.paraphrase) / totals.facts
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  question: 'RQ5b: does each persistent Governor-local archive retain the planted facts from its shadowed source nodes?',
  methodology: {
    source: 'four existing Governor-local compaction/summary events in the first RQ5 durable session logs; offline only, zero model calls',
    sessions,
    seed,
    scorer: 'RQ1 bench scorer form-contract v2, applied to archive checkpoint text; strict full-form = verbatim, loose-only = paraphrase, neither = lost',
    rawLogsCopiedIntoRepository: false,
  },
  archives,
  totals,
  categoryDistribution,
  verification: {
    expectedArchiveCount: 4,
    archiveCount: archives.length,
    allArchivesHavePlantedFacts: archives.every((archive) => archive.plantedFactIds.length > 0),
    allArchiveScoresPerfect: archives.every((archive) => archive.score.strictRate === 1 && archive.score.looseRate === 1),
    zeroModelCalls: true,
  },
}
mkdirSync(resolve(out, '..'), { recursive: true })
writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ file: out, archives: archives.length, totals, categoryDistribution, verification: result.verification }, null, 2))
if (!result.verification.allArchiveScoresPerfect) process.exitCode = 1
