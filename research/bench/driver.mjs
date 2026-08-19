/**
 * RQ1 bench — DSH web-profile RPC driver.
 *
 * One integration path for every live arm: create a session on the running
 * web host (the ARC bridge takes over preset realms there), queue prompts,
 * poll turns to completion, and pull the full event history for the ledger
 * and scorer. Same wire format the browser uses (POST /api/<method>).
 */

export function makeClient(baseUrl) {
  let rpc = 0
  async function call(method, payload, { timeoutMs = 120_000 } = {}) {
    const response = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `bench-${++rpc}`, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json()
    const result = body.result
    if (result?.ok !== true) {
      throw new Error(`${method} failed: ${JSON.stringify(result?.error ?? body).slice(0, 300)}`)
    }
    return result.value
  }
  return { call }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runSession(client, { cwd, model, turns, onTurn }) {
  const created = await client.call('session.create', { cwd })
  const sessionId = created.sessionId
  if (model && model.provider && model.model) {
    await client.call('session.selectModel', {
      sessionId,
      provider: model.provider,
      model: model.model,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    })
  }
  const answers = []
  for (const [index, turn] of turns.entries()) {
    await client.call('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: turn.text }],
    })
    // Poll until this turn settles (running=false after having been true, or
    // a grace period for command-only turns).
    let sawRunning = false
    for (let poll = 0; poll < 240; poll += 1) {
      await sleep(2000)
      const list = await client.call('session.list', {})
      const me = list.items.find((i) => i.sessionId === sessionId)
      if (me?.running === true) sawRunning = true
      else if (sawRunning || poll > 8) break
    }
    if (onTurn) await onTurn(index, turn)
  }
  const history = await client.call('session.history', { sessionId, maxMessages: 100000 })
  return { sessionId, agentPreset: created.agentPreset, history: history.events, projections: history.projections }
}

/** Normalize an event log into assistant calls + compaction markers + query-turn corpus. */
export function extractRun(events, { queryTurnCount = 1 } = {}) {
  const calls = []
  const compactions = []
  let maxTurn = 0
  for (const entry of events) {
    const ev = entry.event ?? entry
    const data = ev.data ?? {}
    if (ev.type === 'assistant/message' && data.usage) {
      maxTurn = Math.max(maxTurn, data.turn ?? 0)
      // Event-level usage carries uncached input as `inputTokens` (verified
      // against the DSH tokenUsage projection: inputTokens + cacheReadTokens
      // = prompt for the call). Normalize once, here.
      const u = data.usage
      calls.push({
        seq: ev.seq,
        turn: data.turn,
        step: data.step,
        usage: {
          uncachedInputTokens: u.uncachedInputTokens ?? u.inputTokens ?? 0,
          cacheReadTokens: u.cacheReadTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
        },
        prevSeq: ev.seq > 0 ? ev.seq - 1 : 0,
      })
    }
    if (ev.type === 'compaction/end') {
      compactions.push({ compactionId: data.compactionId, afterSeq: ev.seq, turn: data.turn })
    }
  }
  // Query-turn corpus: assistant text + tool results from the last `queryTurnCount` turns.
  const corpus = []
  const toolCorpus = []
  for (const entry of events) {
    const ev = entry.event ?? entry
    const data = ev.data ?? {}
    const inQuery = (data.turn ?? 0) > maxTurn - queryTurnCount
    if (!inQuery) continue
    if (ev.type === 'assistant/message') {
      for (const block of data.message?.content ?? []) {
        if (block.type === 'text') corpus.push(block.text)
      }
    }
    if (ev.type === 'tool/result') {
      for (const outer of data.message?.content ?? []) {
        for (const inner of outer.content ?? []) {
          if (inner.type === 'text') toolCorpus.push(inner.text)
        }
      }
    }
  }
  return {
    calls,
    compactions,
    queryTurn: maxTurn,
    answerCorpus: corpus.join('\n'),
    toolCorpus: toolCorpus.join('\n'),
  }
}
