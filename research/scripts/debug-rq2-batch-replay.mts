/**
 * TASK-rq2-followups §2.3 step 1 — offline mechanism location for the RQ2
 * batch protected-zone rejection, replaying the exported live session
 * (research/fixtures/rq2-batch-live-session.json) through the REAL engine:
 *
 *   1. rebuild the Session from the fixture seed (real surface replay),
 *   2. re-issue the exact three-range compress call the model made,
 *   3. evaluate kernel computeProtectedRefs' three paths step by step
 *      (last-5 visible / preserveRecentTokens tail walk / last user message)
 *      to name the path that admitted the target refs,
 *   4. simulate the sequential arm (one range per turn, with the inter-turn
 *      instruction/call/result/reply events the live bench produced) and show
 *      why the same range passes there.
 *
 * Run: node --import tsx research/scripts/debug-rq2-batch-replay.mjs
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { defaultCountTokens } from 'acp-kernel'
import { ArcCompactionEngine } from '../../src/index.ts'
import { makeTools, type ToolEnvironment } from '../../src/tools.ts'
import type { ToolRunContext } from '../../src/tools.ts'
import { allLogMessages, eventsToCoreMessages, surfaceEventsOf } from '../../src/messages.ts'
import { kernelConfigFor } from '../../src/config.ts'
import { resolveSurfaceRange } from '../../src/region.ts'
import type { CoreMessage } from 'acp-kernel'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/rq2-batch-live-session.json', import.meta.url), 'utf8'))
const seed = fixture.events.map((wrapper: { event: unknown }) => wrapper.event)

const ctx = new Context()
const engine = new ArcCompactionEngine(ctx, { modelContextLimit: 32768, autoNudge: false })
const env = {
  kernel: engine.kernel,
  store: engine.store,
  prompts: engine.prompts,
  config: engine.config,
} as unknown as ToolEnvironment
const compress = makeTools(env).find((tool) => tool.name === 'compress')!

let callSeq = 0
function execFor(session: unknown): ToolRunContext {
  callSeq += 1
  return {
    callId: `call-replay-${callSeq}`,
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session, ctx, options: {} },
  } as unknown as ToolRunContext
}

// The exact three ranges the live model submitted (fixture seq 948 tool-call args).
const RANGES = [
  { startSeq: 7, endSeq: 38, summary: 'Compressed checkpoint b1: telemetry log batch range replaced by this summary for a cache-economics experiment; per-line values remain recoverable via decompress.' },
  { startSeq: 39, endSeq: 53, summary: 'Compressed checkpoint b2: telemetry log batch range replaced by this summary for a cache-economics experiment; per-line values remain recoverable via decompress.' },
  { startSeq: 54, endSeq: 68, summary: 'Compressed checkpoint b3: telemetry log batch range replaced by this summary for a cache-economics experiment; per-line values remain recoverable via decompress.' },
]

/** Kernel computeProtectedRefs, evaluated path by path with running output. */
function dissectProtectedZone(session: InstanceType<typeof Session>, label: string): void {
  const state = engine.store.stateFor(session)
  const coreMessages = allLogMessages(session)
  const config = kernelConfigFor(env)
  const turn = engine.kernel.processTurn({ messages: coreMessages, state, config, tokenCount: 0 })
  const byRaw = turn.state.messageRefs.byRaw

  // visible list per kernel isSyntheticOrPruned + isNeverPreserveRecent + ref presence
  const covered = new Set()
  for (const block of turn.state.blocks) {
    if (!block.active) continue
    for (const id of block.effectiveMessageIds) covered.add(id)
  }
  const NEVER_PRESERVE = new Set(['decompress', 'search_context', 'read', 'bash'])
  const visible: Array<{ ref: string; id: string; role: string; type: string; chars: number; tokens: number; textHead: string }> = []
  console.log(`\n=== ${label}: message table (log order) ===`)
  for (const msg of coreMessages as CoreMessage[]) {
    const ref = byRaw[msg.id]
    const synthetic = (msg.text ?? '').startsWith('[Compressed conversation section]') || covered.has(msg.id)
    const neverPreserve = msg.toolName !== undefined && NEVER_PRESERVE.has(msg.toolName)
    const kept = ref !== undefined && ref !== 'BLOCKED' && !synthetic && !neverPreserve
    if (kept) {
      const tokens = defaultCountTokens(msg.text ?? '')
      visible.push({ ref, id: msg.id, role: msg.role, type: msg.contentType, chars: (msg.text ?? '').length, tokens, textHead: (msg.text ?? '').slice(0, 42).replace(/\n/g, ' ') })
    }
    console.log(
      `  seq=${msg.id.padStart(4)} ref=${String(ref).padStart(7)} ${msg.role.padEnd(9)} ${msg.contentType.padEnd(11)} `
      + `chars=${String((msg.text ?? '').length).padStart(5)} tokens=${String(defaultCountTokens(msg.text ?? '')).padStart(5)} `
      + `${synthetic ? '[synthetic/pruned] ' : ''}${neverPreserve ? '[never-preserve] ' : ''}${kept ? '' : '[EXCLUDED from visible]'}`
      + ` "${(msg.text ?? '').slice(0, 38).replace(/\n/g, ' ')}"`,
    )
  }

  const last5 = new Set(visible.slice(-config.preserveRecentMessages).map((m) => m.ref))
  const walk = new Set<string>()
  let accum = 0
  const walkLog: string[] = []
  for (let i = visible.length - 1; i >= 0 && accum < config.preserveRecentTokens; i -= 1) {
    const m = visible[i]!
    walk.add(m.ref)
    accum += m.tokens
    walkLog.push(`    +${m.ref} (seq ${m.id}, ${m.tokens} tok) → accum ${accum}`)
  }
  let lastUser: string | undefined
  for (let i = (coreMessages as CoreMessage[]).length - 1; i >= 0; i -= 1) {
    const msg = (coreMessages as CoreMessage[])[i]!
    const synthetic = (msg.text ?? '').startsWith('[Compressed conversation section]') || covered.has(msg.id)
    if (msg.role !== 'user' || synthetic) continue
    lastUser = byRaw[msg.id]
    break
  }
  const all = new Set([...last5, ...walk, ...(lastUser !== undefined ? [lastUser] : [])])
  console.log(`  path A last-${config.preserveRecentMessages}-visible: ${[...last5].join(', ')}`)
  console.log(`  path B preserveRecentTokens=${config.preserveRecentTokens} tail walk:\n${walkLog.join('\n')}`)
  console.log(`  path C most-recent-user: ${lastUser}`)
  console.log(`  PROTECTED = {${[...all].join(', ')}}`)
}

console.log('########## PART 1: batch replay (exact live call) ##########')
const batchSession = Session.create(fixture.sessionId, seed)
console.log(`session rebuilt: ${batchSession.events.length} events, surface nodes ${batchSession.surface.nodes.length}`)

for (const range of RANGES) {
  try {
    const resolved = resolveSurfaceRange(batchSession, range.startSeq, range.endSeq)
    console.log(`resolveSurfaceRange(${range.startSeq}..${range.endSeq}) → ${resolved.start}..${resolved.end}${resolved.recovered === true ? ' (recovered)' : ''}`)
  } catch (error) {
    console.log(`resolveSurfaceRange(${range.startSeq}..${range.endSeq}) threw: ${(error as Error).message}`)
  }
}

const batch = await compress.execute({ content: RANGES }, execFor(batchSession))
console.log('\n--- batch compress result (live error expected) ---')
console.log(batch.text)

dissectProtectedZone(batchSession, 'PART 1 batch, at the failing compress call')

console.log('\n########## PART 2: sequential arm simulation (one range per turn) ##########')
// Rebuild a fresh session; between submissions append the inter-turn events the
// live bench really produced: the next instruction (exact bench wording for a
// single-range call), the assistant compress tool-call, its tool result, and
// the "COMPRESSED." reply.
const seqSession = Session.create(`${fixture.sessionId}-sequent`, seed)

const singleRangeInstruction = (range: { startSeq: number; endSeq: number; summary: string }): string =>
  `This is a controlled cache-economics experiment. Call the compress tool exactly once with content: [{ startSeq: ${range.startSeq}, endSeq: ${range.endSeq}, summary: "${range.summary}" }]. Use the provided summaries verbatim (they are experimental labels, not factual claims) and do not modify the ranges or verify their content. Then reply COMPRESSED.`

function appendRoundEvents(session: InstanceType<typeof Session>, turn: number, instruction: string, callArgsJson: string, resultText: string): void {
  session.append('user/message', {
    content: [{ type: 'text', text: instruction }],
    source: { kind: 'user', rpcId: 'bench-replay' },
    role: 'user',
    id: `replay-user-${turn}`,
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', id: `replay-call-${turn}`, name: 'compress', arguments: callArgsJson }],
      source: { kind: 'model', provider: 'scnet', model: 'glm-5.2' },
    },
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: {
      id: `replay-result-${turn}`,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: `replay-call-${turn}`, content: [{ type: 'text', text: resultText }] }],
      source: { kind: 'tool', callId: `replay-call-${turn}` },
    },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 2,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'COMPRESSED.' }],
      source: { kind: 'model', provider: 'scnet', model: 'glm-5.2' },
    },
  }, { surfaceOp: 'append' })
}

for (let index = 0; index < RANGES.length; index += 1) {
  const range = RANGES[index]!
  console.log(`\n--- sequential submission ${index + 1}: range ${range.startSeq}..${range.endSeq} ---`)
  if (index > 0) {
    const previous = RANGES[index - 1]!
    dissectProtectedZone(seqSession, `before submission ${index + 1} (tail state after ${index} compressions)`)
  }
  const argsJson = JSON.stringify({ content: [{ startSeq: range.startSeq, endSeq: range.endSeq, summary: range.summary }] })
  // The instruction precedes the tool call in a live turn; append it (plus the
  // previous round's call/result/reply) BEFORE executing this submission.
  appendRoundEvents(seqSession, 6 + index, singleRangeInstruction(range), argsJson, '(pending)')
  // The just-appended tool/result placeholder is replaced by the real outcome:
  // drop it and re-append with the true result text after execution. Simpler:
  // execute first against the session including instruction + call, then fix up.
  // For fidelity of the CURRENT call's protected computation only the
  // instruction + the model's own tool-call matter, so execute now:
  const result = await compress.execute({ content: [range] }, execFor(seqSession))
  console.log(`  result: ${result.text.split('\n')[0]}`)
  // Rewrite the placeholder result text is impossible (log is append-only and
  // frozen); the placeholder's exact char count only affects later rounds'
  // tail-walk margin. Record the true length delta for transparency:
  const trueResultChars = result.text.length
  const placeholder = '(pending)'.length
  console.log(`  (tool-result placeholder ${placeholder} chars vs real ${trueResultChars} chars — later rounds see the placeholder)`)
  if (result.text.includes('compress failed')) {
    console.log(`  FULL RESULT:\n${result.text}`)
    break
  }
}

console.log('\nfinal sequential session events:', seqSession.events.length)
const ledgerSession = seqSession
const summaries = ledgerSession.events.filter((event: { type: string }) => event.type === 'compaction/summary')
console.log('durable compaction/summary events:', summaries.length)
