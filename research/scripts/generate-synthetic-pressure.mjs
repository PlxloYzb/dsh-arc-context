#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const outputRoot = resolve(process.argv[2] ?? './work/context-governor-research/synthetic-pressure')

function filler(stage, targetChars) {
  const rows = []
  for (let row = 1; rows.join('\n').length < targetChars; row += 1) {
    const id = `${String(stage).padStart(2, '0')}-${String(row).padStart(6, '0')}`
    rows.push(
      `SYNTHETIC_RECORD ${id} alpha bravo charlie delta echo foxtrot golf hotel ` +
        `inventory stable route green checksum-${id}-context-governor-lab`,
    )
  }
  return rows.join('\n').slice(0, targetChars)
}

function build(name, stageCount, charsPerStage) {
  const dir = join(outputRoot, name)
  const fixture = join(dir, 'fixture')
  mkdirSync(fixture, { recursive: true })
  writeFileSync(join(fixture, 'README.md'), '# Synthetic Context Pressure Fixture\nNo production data.\n')

  const expected = []
  const stages = []
  for (let stage = 1; stage <= stageCount; stage += 1) {
    const canaries = [
      `GOV-${name.toUpperCase()}-S${String(stage).padStart(2, '0')}-BEGIN`,
      `GOV-${name.toUpperCase()}-S${String(stage).padStart(2, '0')}-MIDDLE`,
      `GOV-${name.toUpperCase()}-S${String(stage).padStart(2, '0')}-END`,
    ]
    expected.push({ stage, canaries })
    const body = filler(stage, charsPerStage)
    const midpoint = Math.floor(body.length / 2)
    const payload = `${body.slice(0, midpoint)}\n${canaries[1]}\n${body.slice(midpoint)}`
    stages.push({
      id: stage,
      text:
        `这是完全合成的上下文压力记录。记住三个金丝雀：${canaries[0]}。` +
        `请用 bash 把一行 "${stage}|${canaries.join('|')}" 追加到 {WORKSPACE}/CHECKPOINTS.md，` +
        `然后只回复三个金丝雀。不要复述合成数据。\n\n` +
        `${canaries[0]}\n${payload}\n${canaries[2]}\n`,
    })
  }

  const finalRecall = expected
    .flatMap(({ canaries }) => canaries)
    .join(', ')
  const document = {
    metadata: { synthetic: true, name, stageCount, charsPerStage },
    stages,
    finalQuestion: {
      acp:
        `先调用 acp_status，然后逐字输出本会话全部金丝雀（按阶段顺序），最后简述压缩块与上下文压力。` +
        `期望集合仅用于核验，不要调用外部数据源。`,
      control: `逐字输出本会话全部金丝雀（按阶段顺序）：${finalRecall}`,
    },
  }
  writeFileSync(join(dir, 'stages.json'), JSON.stringify(document))
  writeFileSync(join(dir, 'answer-key.json'), JSON.stringify({ expected }, null, 2))
}

build('safe', 10, 150_000)
build('boundary', 13, 200_000)
build('fallback', 15, 200_000)
console.log(outputRoot)
