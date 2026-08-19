/**
 * RQ2 engine finding — batch multi-range compression at the protected-zone
 * boundary. Observed live (twice, deterministic): a single compress call
 * with three disjoint ranges — each valid alone against the original
 * surface, together covering the compressible span up to the protected
 * zone — was rejected wholesale with "Range is entirely within the
 * protected zone" naming the LAST entry's messages, while the same three
 * ranges compressed one-per-turn all succeeded. Root cause (located offline
 * via research/scripts/debug-rq2-batch-replay.mts against the exported live
 * fixture): the kernel's preserveRecentTokens tail walk over a tail of tiny
 * acknowledgments reached two ranges deep, and a batch call freezes the
 * tail at call time. Fixed in 0.2.0-beta.5: handleCompress applies ranges
 * sequentially, landing each durable checkpoint before the next range's
 * protected-zone computation (see tests/batch-compress-sequential.test.ts
 * for the fixture replay and the preserved batch semantics).
 *
 * This test pins the offline boundary contract after the fix: a batch whose
 * last range only PARTIALLY intersects the protected zone still lands every
 * range (the kernel excludes the protected messages with a warning instead
 * of rejecting), matching the one-per-turn outcome.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ArcCompactionEngine } from '../src/index.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import type { ToolRunContext } from '../src/tools.ts'
import { buildTextSession } from './helpers.ts'

const SUMMARY = 'Compressed checkpoint: range replaced by this summary; originals recoverable via decompress.'

function setup(limit: number): { compress: ReturnType<typeof makeTools>[number], execFor: (session: unknown) => ToolRunContext } {
  const ctx = new Context()
  const engine = new ArcCompactionEngine(ctx, { modelContextLimit: limit, autoNudge: false })
  const env = {
    kernel: engine.kernel,
    store: engine.store,
    prompts: engine.prompts,
    config: engine.config,
  } as unknown as ToolEnvironment
  const compress = makeTools(env).find((tool) => tool.name === 'compress')!
  const execFor = (session: unknown): ToolRunContext => ({
    callId: 'call-batch-boundary',
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session, ctx, options: {} },
  }) as unknown as ToolRunContext
  return { compress, execFor }
}

test('batch and sequential agree at the protected-zone boundary', async () => {
  const { compress, execFor } = setup(32768)
  // 16 messages; the protected zone (last 5) leaves 1..11 compressible.
  const ranges: Array<[number, number]> = [[1, 5], [6, 8], [9, 11]]

  const batchSession = buildTextSession(16)
  const batch = await compress.execute(
    { content: ranges.map(([start, end]) => ({ startSeq: start, endSeq: end, summary: SUMMARY })) },
    execFor(batchSession),
  )
  assert.equal(batch.text.includes('compress failed'), false)
  assert.match(batch.text, /Compressed 3 block\(s\), ~\d+ tokens reclaimed\./)
  assert.equal(
    batchSession.events.filter((event) => event.type === 'compaction/summary').length,
    3,
  )

  let sequentialOk = true
  const seqSession = buildTextSession(16)
  for (const [start, end] of ranges) {
    const single = await compress.execute(
      { content: [{ startSeq: start, endSeq: end, summary: SUMMARY }] },
      execFor(seqSession),
    )
    if (single.text.includes('compress failed')) sequentialOk = false
  }
  assert.equal(sequentialOk, true)
  assert.equal(
    seqSession.events.filter((event) => event.type === 'compaction/summary').length,
    3,
  )
})
