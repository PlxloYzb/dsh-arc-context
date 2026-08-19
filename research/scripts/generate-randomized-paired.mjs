#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const seed = process.argv[2] ?? 'seed-01'
const outputRoot = resolve(process.argv[3] ?? './work/context-governor-research/randomized-paired')
const charsPerStage = Number(process.argv[4] ?? 80_000)
const shape = process.argv[5] ?? 'verbatim'
const stageCount = 4
const factsPerStage = 12

function opaque(label) {
  const hex = createHash('sha256').update(`${seed}\0${label}`).digest('hex').toUpperCase()
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}`
}

function filler(stage, targetChars) {
  const rows = []
  for (let row = 1; rows.join('\n').length < targetChars; row += 1) {
    const digest = createHash('sha256').update(`${seed}:${stage}:${row}`).digest('hex').slice(0, 16)
    rows.push(
      `ARCHIVE_ROW stage=${stage} row=${String(row).padStart(5, '0')} trace=${digest} `
      + 'amber birch cobalt delta ember fjord granite harbor iris juniper kinetic lunar; '
      + `decoy=${opaque(`decoy-${stage}-${row}`)} status=closed`,
    )
  }
  return rows.join('\n').slice(0, targetChars)
}

const expected = []
const stages = []
for (let stage = 1; stage <= stageCount; stage += 1) {
  const facts = Array.from({ length: factsPerStage }, (_, index) => {
    const key = `S${stage}_FACT_${String(index + 1).padStart(2, '0')}`
    return { key, value: opaque(key) }
  })
  expected.push(...facts)
  const body = filler(stage, charsPerStage)
  const cuts = [0, Math.floor(body.length / 3), Math.floor(body.length * 2 / 3), body.length]
  const groups = [facts.slice(0, 3), facts.slice(3, 6), facts.slice(6, 9), facts.slice(9)]
  const renderFact = ({ key, value }) => shape === 'invariant'
    ? `INVARIANT ${key}: ${value}`
    : `VERBATIM_FACT ${key} = ${value}`
  let payload = ''
  for (let index = 0; index < groups.length; index += 1) {
    payload += groups[index].map(renderFact).join('\n') + '\n'
    payload += body.slice(cuts[index], cuts[index + 1]) + '\n'
  }
  stages.push({
    id: stage,
    text: [
      `这是完全合成、可公开的随机记忆档案（${seed}，阶段 ${stage}/${stageCount}）。`,
      `${shape === 'invariant' ? 'INVARIANT' : 'VERBATIM_FACT'} 的值是不可推导的精确事实；后续会核验。不要把事实或正文写入文件。`,
      `只用 bash 执行 printf '%s\\n' 'stage-${stage}-ack' >> {WORKSPACE}/TRACE.md，然后只回复 ACK-${stage}。`,
      '',
      payload,
    ].join('\n'),
  })
}

const keys = expected.map(({ key }) => key)
const derived = {
  D1: `${expected[0].value}.${expected.at(-1).value}`,
  D2: `${expected[14].value}/${expected[33].value}`,
  D3: `${expected[7].value}:${expected[26].value}:${expected[41].value}`,
}
const finalPrompt = [
  '禁止调用任何工具、文件或外部数据源。仅根据当前会话回答。',
  '输出一个 JSON 对象：facts 必须包含下列 48 个 key 的逐字值；derived 必须按指定拼接规则给值。不要解释。',
  `keys=${keys.join(',')}`,
  `D1=${keys[0]} + "." + ${keys.at(-1)}`,
  `D2=${keys[14]} + "/" + ${keys[33]}`,
  `D3=${keys[7]} + ":" + ${keys[26]} + ":" + ${keys[41]}`,
].join('\n')

const dir = join(outputRoot, seed)
const fixture = join(dir, 'fixture')
mkdirSync(fixture, { recursive: true })
writeFileSync(join(fixture, 'README.md'), `# Randomized paired context fixture\nSynthetic seed: ${seed}\n`)
writeFileSync(join(dir, 'stages.json'), JSON.stringify({
  metadata: { synthetic: true, seed, shape, stageCount, factsPerStage, charsPerStage },
  stages,
  finalQuestion: { control: finalPrompt, acp: finalPrompt, basic: finalPrompt },
}))
writeFileSync(join(dir, 'answer-key.json'), JSON.stringify({ seed, expected, derived }, null, 2))
console.log(dir)
