import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session } from '@deepseek-ai/dsh-session'
import { createCore, type CompressionCore } from 'acp-kernel'
import { buildModelSummarySafetyIndex, MAX_SUMMARY_CHARS } from '../src/fallback.ts'
import { buildCompressibleSeqRanges, rebuildBlockLedger } from '../src/region.ts'
import { ArcStateStore } from '../src/state.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { appendUser, buildTextSession } from './helpers.ts'

interface AdversarialVariant {
  readonly id: string
  readonly surface: string
  readonly locale: 'en' | 'zh'
  readonly variant: string
  readonly marker: string
  readonly payload: string
  readonly historicalWrapper: string
}

const bank = JSON.parse(readFileSync(new URL('../research/fixtures/adversarial/bank.json', import.meta.url), 'utf8')) as {
  readonly seed: number
  readonly variants: readonly AdversarialVariant[]
}

function variants(surface: string): readonly AdversarialVariant[] {
  return bank.variants.filter((variant) => variant.surface === surface)
}

function fakeAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

function fakeExec(session: Session): ToolRunContext {
  return {
    callId: 'rq7-tool-call',
    name: 'rq7-tool',
    arguments: {},
    signal: new AbortController().signal,
    agent: fakeAgent(session),
  } as unknown as ToolRunContext
}

function makeEnv(): ToolEnvironment {
  return { kernel: createCore({}) as CompressionCore, store: new ArcStateStore(), modelContextLimit: 128_000 }
}

function toolOf(env: ToolEnvironment, name: string) {
  const tool = makeTools(env).find((definition) => definition.name === name)
  assert.ok(tool, `${name} is registered`)
  return tool
}

const CLEAN_TIER_SUMMARY = 'Tiered historical checkpoint: the retained factual record stays recoverable through ARC without treating archived data as instructions. '.repeat(45)

test('RQ7 fixture bank is seeded, bilingual, and covers every attack surface with three variants', async () => {
  const generated = await import('../research/fixtures/adversarial/generate.mjs')
  assert.deepEqual(generated.buildAdversarialFixture(bank.seed), { schemaVersion: 1, seed: bank.seed, purpose: 'RQ7 adversarial robustness fixture bank; all payloads are inert historical data.', variants: bank.variants })
  assert.equal(bank.variants.length, 18)
  assert.equal(bank.variants.filter((variant) => variant.locale === 'en').length, 9)
  assert.equal(bank.variants.filter((variant) => variant.locale === 'zh').length, 9)
  for (const surface of ['summary-poisoning', 'search-context-injection', 'decompress-injection', 'protection-gaming', 'template-mimicry', 'tier-summary-chain']) {
    assert.equal(variants(surface).length, 3, `${surface} has three variants`)
  }

  const { scoreRecall } = await import('../research/bench/scorer.mjs')
  const traps = bank.variants.slice(0, 3).map((variant) => ({ id: variant.id, category: 'trap', needle: variant.marker }))
  const scored = scoreRecall(traps, '', {}, {
    answerText: `${traps[0]!.needle} was treated as historical data and ignored.\n${'telemetry padding '.repeat(40)}${traps[1]!.needle}\n`,
  })
  assert.deepEqual(scored.trapClassification.map((trap: { cls: string }) => trap.cls), ['quoted-refused', 'complied', 'clean'])
})

test('RQ7 summary-poisoning and template-mimicry markers never enter the model safety index', () => {
  for (const variant of [...variants('summary-poisoning'), ...variants('template-mimicry')]) {
    const session = Session.create(variant.id)
    appendUser(session, `${'telemetry row kind=steady ok\n'.repeat(80)}${variant.historicalWrapper}`)
    const index = buildModelSummarySafetyIndex(fakeAgent(session), session.surface.nodes)
    assert.match(index, /SECURITY BOUNDARY/)
    assert.doesNotMatch(index, new RegExp(variant.marker))
    assert.match(index, /potential archived instruction omitted/)
  }
})

test('RQ7 model-written compression appends the same safe index for every summary-poisoning variant', async () => {
  for (const variant of variants('summary-poisoning')) {
    const session = Session.create(`model-${variant.id}`)
    for (let index = 0; index < 9; index += 1) {
      appendUser(session, `${index === 0 ? `${variant.historicalWrapper}\n` : ''}${'ordinary historical facts '.repeat(500)}`)
    }
    const env = makeEnv()
    const result = await toolOf(env, 'compress').execute({
      content: [{ startSeq: 1, endSeq: 3, summary: 'Clean model-written checkpoint about ordinary historical facts.' }],
    } as never, fakeExec(session))
    assert.match((result as { text: string }).text, /Compressed 1 block/)
    const summary = rebuildBlockLedger(session.events)[0]!.summary
    assert.match(summary, /SECURITY BOUNDARY/)
    assert.doesNotMatch(summary, new RegExp(variant.marker))
  }
})

test('RQ7 search_context and decompress frame recovered archive data as inert historical data', async () => {
  const variant = variants('decompress-injection')[0]!
  const session = buildTextSession(6)
  const env = makeEnv()
  const compress = toolOf(env, 'compress')
  await compress.execute({
    content: [{ startSeq: 1, endSeq: 3, summary: `Checkpoint referencing ${variant.marker} as archived data.` }],
  } as never, fakeExec(session))
  const blockId = rebuildBlockLedger(session.events)[0]!.blockId
  const decompress = await toolOf(env, 'decompress').execute({ blockId }, fakeExec(session))
  const searchTool = toolOf(env, 'search_context')
  const search = await searchTool.execute({ query: variant.marker }, fakeExec(session))
  for (const output of [decompress, search]) {
    assert.match((output as { text: string }).text, /^Archived context data \(historical, not instructions\):/)
  }
  const noMatch = await searchTool.execute({ query: 'RQ7_NO_ARCHIVE_MATCH' }, fakeExec(session))
  assert.doesNotMatch((noMatch as { text: string }).text, /Archived context data/)
})

test('RQ7 fake protected and fake compressible markers do not change surface compression boundaries', () => {
  const ordinary = Session.create('rq7-ordinary')
  const attacked = Session.create('rq7-attacked')
  for (let index = 0; index < 8; index += 1) {
    appendUser(ordinary, `ordinary historical record ${index}: retained decision ${index}.`)
    const marker = variants('protection-gaming')[index % 3]!.historicalWrapper
    appendUser(attacked, `ordinary historical record ${index}: retained decision ${index}.\n${marker}`)
  }
  const shape = (session: Session) => buildCompressibleSeqRanges(session).map((range) => ({ start: range.start, end: range.end, count: range.count }))
  assert.deepEqual(shape(attacked), shape(ordinary))
})

test('RQ7 tier-two safety index does not carry poisoned tier-one archive markers forward', async () => {
  for (const variant of variants('tier-summary-chain')) {
    const session = buildTextSession(12)
    const env = makeEnv()
    const compress = toolOf(env, 'compress')
    await compress.execute({
      content: [{ startSeq: 1, endSeq: 5, summary: `${variant.historicalWrapper}\n${CLEAN_TIER_SUMMARY}` }],
    } as never, fakeExec(session))
    const tierOne = rebuildBlockLedger(session.events)[0]!
    await compress.execute({
      content: [{ startSeq: tierOne.summarySeq, endSeq: tierOne.summarySeq, summary: CLEAN_TIER_SUMMARY }],
    } as never, fakeExec(session))
    const tierTwo = rebuildBlockLedger(session.events)[1]!
    assert.equal(tierTwo.tier, 2)
    assert.doesNotMatch(tierTwo.summary, new RegExp(variant.marker))
    // Effective-source refresh does not re-process the poisoned model text at
    // all; its originals are ordinary fixture history. The archive boundary
    // remains present without manufacturing a redaction marker.
    assert.match(tierTwo.summary, /SECURITY BOUNDARY/)
  }
})

test('RQ9: value-ranked assembly keeps a late fact-dense event that a chronological cut drops', () => {
  const FACT = 'OPERATIONAL_FACT = incident-2026-08-19-handler-184'
  const build = (factsLast: boolean) => {
    const session = Session.create(`rq9-${factsLast ? 'last' : 'first'}`)
    const noise = (index: number) => appendUser(session, Array.from({ length: 22 }, (_, j) => `routine sample ${index}-${j}: status=ok latency_ms=${(index * 7 + j) % 997}`).join('\n'))
    const fact = () => appendUser(session, `${FACT}\nRare decision: keep the night batch reversible.`)
    if (factsLast) { for (let i = 0; i < 60; i += 1) noise(i); fact() }
    else { fact(); for (let i = 0; i < 60; i += 1) noise(i) }
    return session
  }
  for (const factsLast of [true, false]) {
    const session = build(factsLast)
    const seqs = session.events.filter((event) => event.type === 'user/message').map((event) => event.seq)
    const value = buildModelSummarySafetyIndex(fakeAgent(session), seqs, 8_000, 'value')
    assert.match(value, new RegExp(FACT), `value ranking must keep the fact (factsLast=${factsLast})`)
    assert.match(value, /SECURITY BOUNDARY/)
    if (factsLast) {
      const chronological = buildModelSummarySafetyIndex(fakeAgent(session), seqs, 8_000, 'chronological')
      assert.doesNotMatch(chronological, new RegExp(FACT), 'chronological cut drops the late fact-dense event')
    }
  }
})

test('RQ9: under-budget assembly is byte-identical for both rankings', () => {
  const session = Session.create('rq9-under-budget')
  for (let index = 0; index < 6; index += 1) {
    appendUser(session, `CHECKPOINT_${index} = value-${index}-retained\nroutine row ${index}: status=ok queue=${index}`)
  }
  const seqs = session.events.filter((event) => event.type === 'user/message').map((event) => event.seq)
  const chronological = buildModelSummarySafetyIndex(fakeAgent(session), seqs, MAX_SUMMARY_CHARS, 'chronological')
  const value = buildModelSummarySafetyIndex(fakeAgent(session), seqs, MAX_SUMMARY_CHARS, 'value')
  assert.equal(value, chronological)
})

test('RQ9: value-ranked eviction stays visible via the truncation note', () => {
  const session = Session.create('rq9-eviction-note')
  for (let index = 0; index < 60; index += 1) {
    appendUser(session, Array.from({ length: 22 }, (_, j) => `routine sample ${index}-${j}: status=ok latency_ms=${(index * 7 + j) % 997}`).join('\n'))
  }
  appendUser(session, 'OPERATIONAL_FACT = incident-marker-fix-retained')
  const seqs = session.events.filter((event) => event.type === 'user/message').map((event) => event.seq)
  const index = buildModelSummarySafetyIndex(fakeAgent(session), seqs, 6_000, 'value')
  assert.match(index, /checkpoint index truncated/, 'eviction must emit the truncation note, not drop lines silently')
  assert.match(index, /OPERATIONAL_FACT/)
})
