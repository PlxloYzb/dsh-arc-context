/**
 * RQ1 bench — per-call usage ledger and cache-spike detection.
 *
 * Consumes normalized assistant-call records (see driver.mjs) in seq order
 * and produces: totals in the project's three-field cost vocabulary, a
 * per-call series, and — the RQ2 primitive — the cache-write spike after
 * each compaction event: the jump in uncached input on the first call after
 * a surface replacement, relative to the pre-compaction call.
 */

export function buildLedger(calls, compactions = []) {
  const compactionSeqs = compactions.map((c) => c.afterSeq)
  let uncachedInputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  const series = []
  let prevUncached = null
  for (const call of calls) {
    const u = call.usage ?? {}
    uncachedInputTokens += u.uncachedInputTokens ?? 0
    outputTokens += u.outputTokens ?? 0
    cacheReadTokens += u.cacheReadTokens ?? 0
    const spikeVsPrev = prevUncached === null || u.uncachedInputTokens === undefined
      ? null
      : u.uncachedInputTokens - prevUncached
    series.push({
      seq: call.seq,
      turn: call.turn,
      step: call.step,
      uncachedInputTokens: u.uncachedInputTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      afterCompaction: compactionSeqs.includes(call.prevSeq),
      spikeVsPrev,
    })
    prevUncached = u.uncachedInputTokens ?? prevUncached
  }
  const spikes = series
    .filter((s) => s.afterCompaction && s.spikeVsPrev !== null && s.spikeVsPrev > 0)
    .map((s) => ({ seq: s.seq, spikeTokens: s.spikeVsPrev }))
  return {
    totals: { uncachedInputTokens, outputTokens, cacheReadTokens, totalPromptTokens: uncachedInputTokens + cacheReadTokens },
    series,
    cacheSpikesAfterCompaction: spikes,
  }
}
