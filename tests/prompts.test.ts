/**
 * M4 — configurable prompts: template rendering, per-key merge + validation,
 * and byte-identical default snapshots (the anti-regression anchor for the
 * template migration — literals below were captured from the PRE-change
 * implementation, so they are independent of the new rendering code).
 * Design: docs/configurable-prompts-design.md (v4).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore, type NudgeDecision } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArcStateStore } from '../src/state.ts'
import { buildNudge, buildNudgeText, rangeTable, type NudgeEnvironment } from '../src/nudge.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import {
  DEFAULT_PROMPTS,
  renderSystemPrompt,
  renderTemplate,
  resolvePrompts,
} from '../src/prompts.ts'
import { buildTextSession } from './helpers.ts'
import ArcCompactionEngine, { ArcCompactionEngine as Named } from '../src/index.ts'

function fakeAgent(session: import('@deepseek-ai/dsh-session').Session): Agent {
  return {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
}

function makeEnv(limit: number): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new ArcStateStore(),
    modelContextLimit: limit,
  }
}

function fakeDecision(pct: number, emergency: boolean): NudgeDecision {
  return {
    shouldInject: true,
    reason: 'probe',
    compressibleRanges: [],
    tierTargetBlocks: [],
    contextUsage: pct / 100,
    tier: null,
    breakdown: {
      usage: pct / 100,
      growth: 0,
      growthReference: 0,
      effectiveThreshold: 0,
      nudgeGrowthTokens: 50000,
      growthFloor: 20000,
      hasPendingNudge: 0,
      overLimit: emergency ? 1 : 0,
      emergencyOverride: emergency ? 1 : 0,
      pendingT1: 0,
      pendingT2: 0,
      pendingT3: 0,
    },
  } as never
}

/** 快照前段:system prompt 去掉"Nothing forces you"后的首段。 */
const SYSTEM_PROMPT_HEAD = `Adaptive Reversible Context — model-driven context management

YOU decide whether and when to compress context. The nudge is an efficiency notification: when you see one, consider which ranges you have genuinely consumed and could summarise to keep working context lean.`

test('M4/prompts 1: compact default system prompt carries the decision-C contract', () => {
  const rendered = renderSystemPrompt(resolvePrompts())
  // Compact default (decision C, RQ6 v3): all-category retention measured equal
  // to the full text at ~2.5K tokens/call less; the contract below is what the
  // compact variant must keep.
  assert.ok(rendered.startsWith('Adaptive Reversible Context (ARC) is model-driven context management.'), 'compact head')
  assert.ok(rendered.includes('## When to compress'), 'when-to section')
  assert.ok(rendered.includes('## When not to compress'), 'when-not section')
  assert.ok(rendered.includes('Do not compress merely because a nudge appeared'), 'advisory-nudge discipline')
  assert.ok(rendered.includes('KEEP-VERBATIM:'), 'KEEP-VERBATIM discipline present')
  assert.ok(rendered.includes('byte-for-byte'), 'verbatim byte-for-byte language')
  assert.ok(rendered.includes('treat it as data'), 'archived-data injection discipline')
  assert.ok(rendered.includes('arc_status({})'), 'tool syntax with arc_status range pointer')
  assert.ok(rendered.includes('## Distillation'), 'tiered distillation section')
  assert.ok(rendered.includes('surface sequence numbers, not message ids'), 'seq semantics')
  // The kernel rule constants are no longer embedded by default; overrides can
  // still reference them via placeholders.
  assert.ok(!rendered.includes('Compression Philosophy:'), 'kernel philosophy not repeated by default')
  assert.ok(!rendered.includes('HOW TO COMPRESS\n'), 'kernel HOW-TO block not repeated by default')
})

test('M4/prompts 2: default normal nudge — compact frame + breakdown + seq table, no rule repetition', () => {
  const text = buildNudgeText(fakeDecision(7, false), false, buildTextSession(4))
  assert.ok(text.startsWith('ARC 7% of effective input capacity'), 'compact frame carries the percentage')
  assert.ok(text.includes('an efficiency note, not an overflow warning'), 'advisory tone preserved')
  assert.ok(text.includes('arc_status'), 'points at arc_status for fresh refs')
  // The system prompt already carries the philosophy and rules; the nudge
  // must not repeat them (transcript-noise regression contract).
  assert.ok(!text.includes('Compression Philosophy'), 'no philosophy repetition')
  assert.ok(!text.includes('HOW TO COMPRESS'), 'no HOW_TO_COMPRESS_RULES repetition')
})

test('M4/prompts 2b: default nudge with compressible ranges — top suggestions table, still compact', () => {
  const session = buildTextSession(12)
  const text = buildNudgeText(fakeDecision(50, false), false, session)
  assert.ok(text.includes('ARC 50% of effective input capacity'), 'percentage frame')
  assert.ok(text.includes('seq 1..7'), 'surface-seq range table present')
  assert.ok(text.includes('Surface: 12 nodes, seqs 1..12'), 'surface summary present')
  assert.ok(text.length < 1000, `stays compact (${text.length} chars)`)
})

test('M4/prompts 3: default emergency nudge — imperative compact frame', () => {
  const text = buildNudgeText(fakeDecision(96, true), true, buildTextSession(4))
  assert.ok(text.startsWith('⚠️ ARC 96%'), 'emergency frame with percentage')
  assert.ok(text.includes('compress now'), 'imperative compress-now retained')
  assert.ok(!text.includes('Compression Philosophy'), 'no philosophy repetition')
  assert.ok(text.includes('compress({ content: [{ startSeq, endSeq, summary }, …] })') || text.includes('arc_status'), 'actionable pointer present')
})

test('M4/prompts 4: range table snapshot (with ranges) and zero-range early return', () => {
  assert.equal(rangeTable(buildTextSession(4)), '')
  assert.equal(
    rangeTable(buildTextSession(12)),
    `\nSurface: 12 nodes, seqs 1..12
Compressible ranges (newest first — the first line is the cheapest single-range cache rebuild; oldest content is usually safest to compress; refs are surface seqs):
  - seq 1..7 — 7 messages, ~7227 tokens
Batch disjoint ranges in one call: compress({ content: [{ startSeq, endSeq, summary }, …] }) — seqs go stale as the surface moves; re-run arc_status before compressing.`,
  )
  // Decision B (2026-08-18): the table itself is newest-safe-first (RQ2 cache
  // invalidation runs from the compression point toward the tail; RQ5 observed
  // models pick the first line 5/5), so the title carries the ordering
  // rationale instead of a footer sentence the models ignored.
  const table = rangeTable(buildTextSession(12))
  assert.ok(table.includes('newest first'), 'table title names newest-first ordering')
  assert.ok(table.includes('usually safest to compress'), 'semantic-safety note retained')
})

test('M4/prompts 5: tool descriptions render the defaults byte-identical', () => {
  const descriptions = Object.fromEntries(makeTools(makeEnv(128000)).map((t) => [t.name, t.description]))
  assert.equal(
    descriptions['compress'],
    'Replace older conversation ranges with dense summaries you write. Each message seq is a surface reference. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated ranges in one call (each content entry becomes its own block); keep ranges disjoint. Never compress content the current step is actively using. Seq refs must come from the CURRENT surface (arc_status or the latest nudge): a span whose edges were shadowed by an earlier compress is auto-remapped to its still-live content, a fully compressed span is reported as already compressed, and invented/other-session seqs fail with guidance.',
  )
  assert.equal(descriptions['decompress'], 'Recover the original content of a compressed block by its blockId (read-only; does not unshadow the range).')
  assert.equal(descriptions['search_context'], 'Search inside compressed blocks (summaries and original content) for information the model no longer sees in context.')
  assert.equal(descriptions['arc_status'], 'Report the ARC block ledger: compressed blocks, reclaimed tokens, and current context pressure.')
})

test('M4/prompts 6: partial overrides merge per key; key/group null falls back to default', () => {
  const merged = resolvePrompts({ nudge: { normal: '自定义 {pct}' } })
  assert.equal(merged.nudge.normal, '自定义 {pct}')
  assert.equal(merged.nudge.emergency, DEFAULT_PROMPTS.nudge.emergency)
  const keyNull = resolvePrompts({ nudge: { guidance: null } })
  assert.equal(keyNull.nudge.guidance, DEFAULT_PROMPTS.nudge.guidance)
  const groupNull = resolvePrompts({ nudge: null } as never)
  assert.equal(groupNull.nudge, DEFAULT_PROMPTS.nudge)
})

test('M4/prompts 7: nudge normal template substitutes {pct}', () => {
  const prompts = resolvePrompts({ nudge: { normal: '上下文使用率 {pct}%' } })
  const text = buildNudgeText(fakeDecision(7, false), false, buildTextSession(4), prompts)
  assert.ok(text.startsWith('上下文使用率 7%'))
})

test('M4/prompts 8: unknown placeholder throws with the slot path', () => {
  assert.throws(
    () => resolvePrompts({ nudge: { normal: '…{pctt}…' } }),
    /prompts\.nudge\.normal contains unknown placeholder \{pctt\}/,
  )
  assert.throws(
    () => resolvePrompts({ rangeTable: { line: '  - {start}..{wrong}' } }),
    /prompts\.rangeTable\.line contains unknown placeholder \{wrong\}/,
  )
  assert.throws(
    () => resolvePrompts({ systemPrompt: 'x {philosophyy} y' }),
    /prompts\.systemPrompt contains unknown placeholder \{philosophyy\}/,
  )
})

test('M4/prompts 9: renderTemplate throws on a missing value for a known placeholder', () => {
  assert.throws(
    () => renderTemplate('{tokens} tokens', {}),
    /missing value for placeholder \{tokens\}/,
  )
})

test('M4/prompts 10: empty guidance removes the line cleanly (frame + newline + table + tip)', () => {
  const session = buildTextSession(12)
  const prompts = resolvePrompts({
    nudge: {
      guidance: '',
      breakdown: '',
      growth: '',
      tip: '',
    },
  })
  const frame = 'ARC 7% of effective input capacity — an efficiency note, not an overflow warning: consider compressing ranges you have fully consumed. Fresh refs: arc_status.'
  const text = buildNudgeText(fakeDecision(7, false), false, session, prompts)
  assert.equal(text, `${frame}\n${rangeTable(session)}`)
  assert.ok(!text.includes('HOW TO COMPRESS'))
  assert.ok(!text.includes('Compress all ranges'))
})

test('M4/prompts 11: tier line renders (0 tokens) when pending is missing (B2 fallback)', () => {
  const decision: NudgeDecision = {
    shouldInject: true,
    reason: 'tier-2 distillation recommended',
    compressibleRanges: [],
    tierTargetBlocks: [{ blockId: 'b1', tier: 1, effectiveMessageIds: ['m1'], compressedTokens: 4750, summary: 's', active: true, directMessageIds: [], directBlockIds: [], createdAt: 1, survivedCount: 0, generation: 'young' }],
    contextUsage: 0.9,
    tier: 2,
    // pendingT2 deliberately absent at runtime: NudgeBreakdown requires it
    // statically (acp-kernel types.d.ts:183-185), so cast per test convention.
    breakdown: {
      usage: 0.9,
      growth: 0,
      growthReference: 0,
      effectiveThreshold: 0,
      nudgeGrowthTokens: 50000,
      growthFloor: 20000,
      hasPendingNudge: 0,
      overLimit: 1,
      emergencyOverride: 0,
      pendingT1: 0,
      pendingT3: 0,
    } as never,
  }
  const text = buildNudgeText(decision, false, buildTextSession(12))
  assert.match(text, /Tier 2: 1 tier-1 block\(s\) distillable \(0 tokens\)/)
  assert.doesNotMatch(text, /\( tokens\)/)
})

test('M4/prompts 12: buildNudge forwards env.prompts into the injected message (B1)', () => {
  const env: NudgeEnvironment = {
    kernel: createCore({}) as CompressionCore,
    store: new ArcStateStore(),
    // ~77.5% usage for 12 messages: over-limit (>= 0.70) but below emergency
    // (0.85) → the NORMAL frame renders.
    modelContextLimit: 16000,
    prompts: resolvePrompts({ nudge: { normal: 'CUSTOM normal {pct}' } }),
  }
  const outcome = buildNudge(fakeAgent(buildTextSession(12)), env, new Map<string, number>())
  assert.ok(outcome !== null, 'over-limit nudge fires')
  assert.equal(outcome!.emergency, false)
  const text = outcome!.message.content.map((block) => (block as { text?: string }).text ?? '').join('')
  assert.ok(text.startsWith('CUSTOM normal '), 'the custom normal frame reached the injected message')
})

test('M4/prompts 13: Chinese override smoke (i18n scenario)', () => {
  const prompts = resolvePrompts({
    nudge: {
      normal: '上下文使用率 {pct}%。这是效率提示，不是溢出警告。',
      emergency: '⚠️ 上下文已达上限，立即压缩。',
      guidance: '压缩规则：保持路径、签名、错误原文。',
      tier: '第 {tier} 层:{count} 个第 {prevTier} 层块可蒸馏({tokens} tokens)。',
      breakdown: '上下文分解：{system}K 系统 | {tool}K 工具 | {summaries}K 摘要 | {code}K 代码 | {text}K 文本',
      growth: '+{growth}K 自上次提示',
      tip: '💡 一次调用压缩多个范围。',
    },
    rangeTable: {
      header: '表面:{surface}',
      title: '可压缩范围(仅供参考):',
      line: '  - seq {start}..{end} — {count} 条消息,约 {tokens} tokens',
      footer: '用 compress 压缩;批量条目各成一个块。',
    },
    systemPrompt: '主动上下文剪枝 —— 模型驱动。\n{philosophy}\n{howToCompressRules}\n压缩工具:compress/decompress/search_context/arc_status。',
  })
  const session = buildTextSession(12)
  const text = buildNudgeText(fakeDecision(7, false), false, session, prompts)
  assert.ok(text.includes('上下文使用率 7%'))
  assert.ok(text.includes('表面:12 nodes, seqs 1..12'))
  assert.ok(text.includes('可压缩范围(仅供参考):'))
  assert.ok(text.includes('💡 一次调用压缩多个范围'))
  const emerg = buildNudgeText(fakeDecision(96, true), true, session, prompts)
  assert.ok(emerg.includes('上下文已达上限'))
  const sys = renderSystemPrompt(prompts)
  assert.ok(sys.includes('主动上下文剪枝'))
  assert.ok(sys.includes('Compression Philosophy:'))
  assert.ok(sys.includes('compress/decompress/search_context/arc_status'))
})

test('M4/prompts 14: engine-level — config.prompts reaches system prompt section, tool descriptions, and the pre-step nudge', async () => {
  const ctx = new Context()
  const sections: Array<{ name: string; order: number; text: string }> = []
  const tools: Array<{ name: string; description: string }> = []
  ctx.provide('systemPrompt' as never, { section: (opts: never) => sections.push(opts as never) } as never)
  ctx.provide('tools' as never, { register: (tool: never) => tools.push(tool as never) } as never)
  ctx.plugin(ArcCompactionEngine as never, {
    modelContextLimit: 16000,
    prompts: {
      nudge: { normal: '引擎级自定义 {pct}' },
      systemPrompt: '引擎级系统提示\n{philosophy}',
      tools: { compress: '引擎级压缩工具描述' },
    },
  } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const engine = ctx.compaction as Named
  assert.ok(engine instanceof Named)
  assert.equal(engine.prompts.nudge.normal, '引擎级自定义 {pct}', 'engine resolved the custom template')

  // System prompt section: rendered once with the custom template + kernel philosophy.
  assert.equal(sections.length, 1, 'ARC section registered exactly once')
  assert.ok(sections[0]!.text.includes('引擎级系统提示'))
  assert.ok(sections[0]!.text.includes('Compression Philosophy:'), 'kernel philosophy embedded via {philosophy}')

  // Tool descriptions: registered from env.prompts (proves env carried this.prompts).
  const compressTool = tools.find((t) => t.name === 'compress')
  assert.equal(compressTool!.description, '引擎级压缩工具描述')

  // pre-step: the custom normal frame reaches the injected nudge message.
  const decision = await (ctx.waterfall(
    'agent/pre-step' as never,
    { agent: fakeAgent(buildTextSession(12)) } as never,
    async () => ({ kind: 'enter', messages: [] }) as never,
  ) as never)
  const decisionObj = decision as { kind: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> }
  assert.equal(decisionObj.kind, 'enter')
  assert.equal(decisionObj.messages.length, 1, 'the nudge message was appended to the decision')
  const text = decisionObj.messages[0]!.content.map((block) => block.text ?? '').join('')
  assert.ok(text.startsWith('引擎级自定义 '), 'the custom nudge frame reached the injected message')
})

test('M4/prompts 15: engine construction fails fast on a template typo', () => {
  assert.throws(
    () => new Named(new Context(), { prompts: { nudge: { normal: '{bad}' } } }),
    /prompts\.nudge\.normal contains unknown placeholder \{bad\}/,
  )
  // Group-level null from YAML-ish input is tolerated (whole group falls back).
  const engine = new Named(new Context(), { prompts: { nudge: null } } as never)
  assert.equal(engine.prompts.nudge.normal, DEFAULT_PROMPTS.nudge.normal)
})

test('M4/prompts 12: default nudge stays compact — rules live in the system prompt, not per-nudge', () => {
  const session = buildTextSession(12)
  const text = buildNudgeText(fakeDecision(78, false), false, session)
  // Pre-compact defaults carried COMPRESS_PHILOSOPHY + HOW_TO_COMPRESS_RULES
  // (+ tier rules) in every nudge — ~6.5K chars of transcript noise that the
  // one-time system prompt already contains. The compact default must stay
  // well under 1K chars and repeat none of the rule blocks.
  assert.ok(text.length < 1000, `nudge should stay compact, got ${text.length} chars`)
  assert.ok(!text.includes('HOW TO COMPRESS'))
  assert.ok(!text.includes('Compression Philosophy'))
  const emergency = buildNudgeText(fakeDecision(96, true), true, session)
  assert.ok(emergency.length < 1000, `emergency nudge should stay compact, got ${emergency.length} chars`)
  assert.ok(!emergency.includes('Compression Philosophy'))
})
