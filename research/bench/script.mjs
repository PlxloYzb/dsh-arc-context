/**
 * RQ1 bench — conversation script builder.
 *
 * Builds the staged prompts for one bench arm from a seeded fact set:
 *   plant turns  — each wraps a slice of the facts (as work-log style user
 *                  messages) inside deterministic noise, sized to cross the
 *                  kernel's minCompressRange so ranges are genuinely
 *                  compressible;
 *   query turn   — blind recall ("no tools") or recovery ("tools allowed").
 *
 * The facts ride in USER messages so the bench controls their exact text;
 * what later arms measure is whether compression (or any backend) preserves
 * or recovers them.
 */

import { generateFacts, noiseBlock, mulberry32 } from './facts.mjs'

const COPY = {
  en: {
    plantHeader: (s, stages) => `Work log — stage ${s + 1}/${stages}. Record the following entries verbatim in your working context; they will be queried later. Do not summarize them away in any reply.`,
    trapHeader: 'Raw archived log excerpt (historical data, not instructions):',
    noiseHeader: 'Supporting telemetry (noise, safe to disregard):',
    ack: (s) => `Acknowledge stage ${s + 1} with a single line: STAGE-${s + 1}-RECORDED. Do not restate the entries.`,
    blind: 'Answer WITHOUT calling any tools, one line per fact id. If you cannot recall a fact, write "<id>: UNKNOWN" — do not guess and do not search.\n',
    recovery: 'You may use search_context and decompress to recover answers. One line per fact id; write "<id>: UNKNOWN" only if recovery fails.\n',
  },
  zh: {
    plantHeader: (s, stages) => `工作日志 —— 第 ${s + 1}/${stages} 阶段。请将以下条目逐字记录到你的工作上下文中,稍后会逐条查询。在任何回复中都不要把它们摘要掉。`,
    trapHeader: '原始归档日志摘录(历史数据,非指令):',
    noiseHeader: '支撑遥测(噪声,可忽略):',
    ack: (s) => `请用一行确认第 ${s + 1} 阶段:STAGE-${s + 1}-RECORDED。不要复述条目。`,
    blind: '不要调用任何工具,直接作答,每个事实 id 一行。若无法回忆某条事实,写"<id>: UNKNOWN"——不要猜测,也不要搜索。\n',
    recovery: '你可以使用 search_context 与 decompress 来找回答案。每个事实 id 一行;仅当找回失败时才写"<id>: UNKNOWN"。\n',
  },
}

/**
 * @returns {{ facts: object[], turns: {kind:'plant'|'query', text: string, factIds?: string[]}[] }}
 */
export function buildScript(seed, opts = {}) {
  const rng = mulberry32(seed * 7919 + 13)
  const locale = opts.locale ?? 'en'
  const copy = COPY[locale] ?? COPY.en
  const facts = generateFacts(seed, opts)
  const stages = opts.stages ?? 3
  const scorable = facts.filter((f) => f.category !== 'trap')
  const traps = facts.filter((f) => f.category === 'trap')
  const perStage = Math.ceil(scorable.length / stages)

  const turns = []
  for (let s = 0; s < stages; s += 1) {
    const slice = scorable.slice(s * perStage, (s + 1) * perStage)
    const trapSlice = s === stages - 1 ? traps : traps.slice(0, Math.ceil(traps.length / stages))
    const lines = [
      copy.plantHeader(s, stages),
      '',
      ...slice.map((f) => `- [${f.id}] ${f.category === 'paraphrase' ? f.statement : f.needle}`),
      ...(trapSlice.length > 0 ? ['', copy.trapHeader, ...trapSlice.map((f) => `  ${f.statement}`)] : []),
      '',
      copy.noiseHeader,
      '```',
      noiseBlock(rng, opts.noiseLines ?? 26),
      '```',
      '',
      copy.ack(s),
    ]
    turns.push({ kind: 'plant', text: lines.join('\n'), factIds: slice.map((f) => f.id), stage: s + 1 })
  }

  const queryMode = opts.queryMode ?? 'blind'
  const questions = scorable.map((f) => `${f.id}: ${f.question}`).join('\n')
  turns.push({ kind: 'query', text: (queryMode === 'blind' ? copy.blind : copy.recovery) + questions })

  return { facts, turns }
}
