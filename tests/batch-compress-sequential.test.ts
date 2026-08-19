/**
 * RQ2 batch protected-zone fix — sequential per-range application regression
 * tests (docs/TASK-rq2-followups.md §2.3). handleCompress now applies each
 * range through its own kernel call and lands the durable transaction before
 * the next range's protected-zone computation, with three kernel batch
 * semantics preserved ARC-side:
 *   - the minCompressRange gate stays a cross-range SUM (pre-checked),
 *   - overlap between batch ranges still skips the later range with a warning,
 *   - a failing range is reported honestly beside the ranges that DID land.
 *
 * The fixture test replays the exported live failure session
 * (research/fixtures/rq2-batch-live-session.json): before the fix the exact
 * three-range call was rejected wholesale ("Range is entirely within the
 * protected zone" for m00007/m00008 — the preserveRecentTokens tail walk
 * reaches two ranges deep when the trailing messages are tiny); after the fix
 * each segment's landed checkpoint feeds the next segment's tail walk, which
 * is exactly what made the same ranges succeed one-per-turn live.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { ArcCompactionEngine } from '../src/index.ts'
import { makeTools, type ToolEnvironment, type ToolRunContext } from '../src/tools.ts'
import { rebuildBlockLedger } from '../src/region.ts'
import { appendAssistant, appendTurn, appendUser } from './helpers.ts'

const SUMMARY = 'Compressed checkpoint: range replaced by this summary; originals recoverable via decompress.'

function setup(): { compress: ReturnType<typeof makeTools>[number], execFor: (session: unknown) => ToolRunContext } {
  const ctx = new Context()
  const engine = new ArcCompactionEngine(ctx, { autoNudge: false })
  const env = {
    kernel: engine.kernel,
    store: engine.store,
    prompts: engine.prompts,
    config: engine.config,
  } as unknown as ToolEnvironment
  const compress = makeTools(env).find((tool) => tool.name === 'compress')!
  const execFor = (session: unknown): ToolRunContext => ({
    callId: 'call-batch-sequential',
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session, ctx, options: {} },
  }) as unknown as ToolRunContext
  return { compress, execFor }
}

function compactionCount(session: InstanceType<typeof Session>): number {
  return session.events.filter((event) => event.type === 'compaction/summary').length
}

test('fixture replay: the live three-range batch call now fully lands', async () => {
  const { compress, execFor } = setup()
  const fixture = JSON.parse(
    readFileSync(new URL('../research/fixtures/rq2-batch-live-session.json', import.meta.url), 'utf8'),
  ) as { sessionId: string, events: Array<{ event: unknown }> }
  const session = Session.create(fixture.sessionId, fixture.events.map((wrapper) => wrapper.event))

  const result = await compress.execute({
    content: [
      { startSeq: 7, endSeq: 38, summary: 'Compressed checkpoint b1: telemetry log batch range replaced by this summary for a cache-economics experiment; per-line values remain recoverable via decompress.' },
      { startSeq: 39, endSeq: 53, summary: 'Compressed checkpoint b2: telemetry log batch range replaced by this summary for a cache-economics experiment; per-line values remain recoverable via decompress.' },
      { startSeq: 54, endSeq: 68, summary: 'Compressed checkpoint b3: telemetry log batch range replaced by this summary for a cache-economics experiment; per-line values remain recoverable via decompress.' },
    ],
  }, execFor(session))

  // Before the fix this exact call returned:
  //   compress failed: range m00007..m00008: Range is entirely within the
  //   protected zone ... m00007, m00008.
  assert.equal(result.text.includes('compress failed'), false)
  assert.match(result.text, /Compressed 3 block\(s\), ~\d+ tokens reclaimed\./)
  assert.equal(compactionCount(session), 3)
  // The live defect was specifically the THIRD range (54..68 → balanced pair
  // 54..62); pin that its block landed and reclaimed the two messages.
  const ledger = rebuildBlockLedger(session.events)
  const third = ledger.find((entry) => entry.start === 54 && entry.end === 62)
  assert.notEqual(third, undefined)
  assert.deepEqual(third!.shadowedSeqs, [54, 62])
})

test('partial failure: landed ranges stay landed and the rejection is reported verbatim', async () => {
  const { compress, execFor } = setup()
  const session = Session.create('partial-failure-session')
  appendTurn(session, 1)
  appendUser(session, 'u'.repeat(12000))
  appendAssistant(session, 'ack')
  appendUser(session, 'f'.repeat(12000))
  appendAssistant(session, 'ack')
  appendUser(session, 'f'.repeat(12000))
  appendAssistant(session, 'ack')
  appendUser(session, 'final question')
  appendAssistant(session, 'final answer')

  const result = await compress.execute({
    content: [
      { startSeq: 1, endSeq: 2, summary: SUMMARY },
      // The final user/assistant pair is inside the protected zone (last-5
      // visible + most-recent-user) and STAYS there after range 1 lands.
      { startSeq: 7, endSeq: 8, summary: SUMMARY },
    ],
  }, execFor(session))

  assert.match(result.text, /Compressed 1 of 2 range\(s\), ~\d+ tokens reclaimed\./)
  assert.match(
    result.text,
    /range 2 \(seqs 7\.\.8\) rejected: range m00007\.\.m00008: Range is entirely within the protected zone \(the last 5 messages and\/or the most recent user message\): m00007, m00008\. Adjust startId\/endId to older messages\./,
  )
  // Honest reporting means durable progress: range 1's transaction landed and
  // is NOT rolled back by range 2's rejection.
  assert.equal(compactionCount(session), 1)
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  assert.deepEqual(ledger[0]!.shadowedSeqs, [1, 2])
})

test('cross-range overlap: the later range is skipped with the kernel warning, the earlier lands', async () => {
  const { compress, execFor } = setup()
  const session = Session.create('overlap-session')
  appendTurn(session, 1)
  for (const filler of ['a', 'b', 'c']) {
    appendUser(session, filler.repeat(12000))
    appendAssistant(session, 'x'.repeat(50))
  }
  for (let index = 0; index < 3; index += 1) {
    appendUser(session, 't'.repeat(8000))
    appendAssistant(session, 'x'.repeat(50))
  }

  const result = await compress.execute({
    content: [
      { startSeq: 1, endSeq: 4, summary: SUMMARY },
      // Overlaps range 1 on seqs 3..4 — the kernel batch contract keeps the
      // EARLIER range and skips the later one with a warning.
      { startSeq: 3, endSeq: 6, summary: SUMMARY },
    ],
  }, execFor(session))

  assert.equal(result.text.includes('compress failed'), false)
  assert.match(result.text, /Compressed 1 block\(s\), ~\d+ tokens reclaimed\./)
  assert.match(
    result.text,
    /Skipped range \(m\d+\.\.m\d+\) — overlaps an earlier range in the batch; the earlier range takes precedence\. Keep ranges disjoint\./,
  )
  assert.match(result.text, /\(1 range\(s\) skipped — see above\)/)
  assert.equal(compactionCount(session), 1)
  const ledger = rebuildBlockLedger(session.events)
  assert.deepEqual(ledger[0]!.shadowedSeqs, [1, 2, 3, 4])
})

test('all ranges rejected: zero landing is reported as a compress failure with per-range reasons', async () => {
  const { compress, execFor } = setup()
  const session = Session.create('all-rejected-session')
  appendTurn(session, 1)
  // 6050 chars per range passes the batch SUM gate, but the whole session is
  // only ~3040 tokens — the preserveRecentTokens walk covers every message,
  // so BOTH ranges are entirely inside the protected zone.
  appendUser(session, 'q'.repeat(6000))
  appendAssistant(session, 'x'.repeat(50))
  appendUser(session, 'q'.repeat(6000))
  appendAssistant(session, 'x'.repeat(50))

  const result = await compress.execute({
    content: [
      // Both ranges sit inside the protected zone (tiny session: the
      // preserveRecentTokens walk covers everything).
      { startSeq: 1, endSeq: 2, summary: SUMMARY },
      { startSeq: 3, endSeq: 4, summary: SUMMARY },
    ],
  }, execFor(session))

  assert.match(result.text, /^compress failed: range 1 \(seqs 1\.\.2\) rejected: /)
  assert.match(result.text, /range 2 \(seqs 3\.\.4\) rejected: /)
  assert.match(result.text, /Range is entirely within the protected zone/)
  assert.equal(compactionCount(session), 0)
})

test('batch threshold stays a cross-range SUM: two 3K ranges pass together, fail alone', async () => {
  const build = (): InstanceType<typeof Session> => {
    const session = Session.create('threshold-session')
    // Two requested ranges, 3050 chars each — below the 5000-char kernel
    // minimum INDIVIDUALLY, above it TOGETHER (6100).
    appendUser(session, 'a'.repeat(3000))
    appendAssistant(session, 'x'.repeat(50))
    appendUser(session, 'b'.repeat(3000))
    appendAssistant(session, 'x'.repeat(50))
    // Buffers keep the requested ranges clear of the last-5 zone.
    for (let index = 0; index < 2; index += 1) {
      appendUser(session, 'c'.repeat(3000))
      appendAssistant(session, 'x'.repeat(50))
    }
    // A token-heavy tail (3 × 8000 chars ≈ 6000 tokens) stops the
    // preserveRecentTokens walk at seq 11, before the requested ranges.
    for (let index = 0; index < 3; index += 1) {
      appendUser(session, 't'.repeat(8000))
      appendAssistant(session, 'x'.repeat(50))
    }
    return session
  }

  const batchSetup = setup()
  const batch = await batchSetup.compress.execute({
    content: [
      { startSeq: 1, endSeq: 2, summary: SUMMARY },
      { startSeq: 3, endSeq: 4, summary: SUMMARY },
    ],
  }, batchSetup.execFor(build()))
  assert.equal(batch.text.includes('compress failed'), false)
  assert.match(batch.text, /Compressed 2 block\(s\), ~\d+ tokens reclaimed\./)
  // Both sub-threshold ranges landed — the per-segment kernel gate did not
  // degrade the kernel's cross-range SUM semantics.

  // Negative control: one 3050-char range alone still fails the gate with the
  // kernel's threshold message (a genuinely-too-small single range).
  const singleSetup = setup()
  const single = await singleSetup.compress.execute({
    content: [{ startSeq: 1, endSeq: 2, summary: SUMMARY }],
  }, singleSetup.execFor(build()))
  assert.match(
    single.text,
    /compress failed: Total compressible content too small \(3050 chars across 1 range\(s\), min 5000\)/,
  )
})
