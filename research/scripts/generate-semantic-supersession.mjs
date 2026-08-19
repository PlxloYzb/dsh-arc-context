#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const seed = process.argv[2] ?? 'semantic-seed-01'
const out = resolve(process.argv[3] ?? join('semantic-supersession', seed))
mkdirSync(join(out, 'fixture'), { recursive: true })

const digest = (text) => createHash('sha256').update(`${seed}:${text}`).digest('hex').slice(0, 12)
const vocabulary = [
  '依赖清单', '演练旁听', '容量观察', '供应商回执', '灰度节奏', '告警回看',
  '客服交接', '网络抖动', '仪表盘校对', '合同附件', '发布广播', '审计抽样',
]
function filler(stage, index) {
  const a = vocabulary[(index + stage) % vocabulary.length]
  const b = vocabulary[(index * 5 + stage) % vocabulary.length]
  return `会议旁注 ${String(index).padStart(3, '0')}：${a}与${b}已完成普通核对，追踪号 ${digest(`${stage}:${index}`)}；这条旁注只记录背景进展，不改变上线方案。讨论中提到的示例地点、人员、时间和参数都只是演练素材，不能据此覆盖正式纪要。`
}

const stages = [
  {
    intro: '项目第一次形成可执行草案。以下内容是一份普通会议纪要，没有字段标签；后续纪要可能修改其中一部分。',
    insertions: new Map([
      [24, '团队把主要上线城市定在瓦伦西亚，因为最初的供应商容量只在那里可用。'],
      [61, '具体执行由 Mira Chen 负责，她同时主持上线当天的协调电话。'],
      [103, '冻结窗口安排在星期二 22:40 UTC，预计避开当天结算高峰。'],
      [147, '如果必须回滚，电话里使用的确认短语是 amber violin。'],
      [181, '原始请求与审计轨迹保留 17 天，期满后自动清除。'],
      [218, '生产消息进入 north-river 队列，迁移脚本只监听这个名字。'],
      [252, '每批处理 240 个账户；失败最多重试 5 次，每次间隔 40 秒。'],
      [286, '涉及受监管租户时没有额外地区例外，与普通租户走同一路径。'],
      [309, '上线需要财务负责人和 SRE 值班经理双签，少一方都不能开始。'],
      [331, '对外状态页使用 ivory-status.example，客户只看这里的更新。'],
      [348, '审计归档包采用名称 ledger-saffron，交接时必须逐字一致。'],
    ]),
  },
  {
    intro: '合规复核后，团队修改了若干条款；没有被本次纪要提到的内容继续有效。',
    insertions: new Map([
      [42, '主要上线城市改为塔林，原因是瓦伦西亚供应商的驻留认证已经过期；旧城市不再用于普通租户。'],
      [116, '冻结窗口随之改到星期四 04:15 UTC，因为支付流量在这个时段最低。'],
      [189, '生产消息队列迁移为 cedar-lane，原因是新生产者已经停止向 north-river 发布。'],
      [277, 'Mira Chen 仍然负责执行，本次复核没有改变负责人。'],
      [325, '回滚短语、保留期限、批量、重试、审批、状态页和审计包在本轮均未调整。'],
    ]),
  },
  {
    intro: '压力测试和监管审阅带来第二轮修订；这里的修订覆盖之前冲突的说法。',
    insertions: new Map([
      [37, '原始请求与审计轨迹的保留期延长到 45 天，因为监管方签发了临时法律保全令。'],
      [98, '每批账户数降为 180，原因是 240 个账户同时解密会造成内存尖峰。'],
      [164, '受监管租户暂时仍从瓦伦西亚上线，普通租户继续走塔林；例外持续到驻留审计完成。'],
      [239, '审计归档包改称 ledger-indigo，因为旧名称与另一场演练的包发生冲突。'],
      [301, '其余执行负责人、冻结窗口、回滚短语、队列、重试、审批和状态页都沿用当前版本。'],
    ]),
  },
  {
    intro: '上线前最后一次演练只改动三项；未被提到的既有条款继续生效，不要用更早的冲突版本替代它们。',
    insertions: new Map([
      [53, '执行负责人换成 Noor Haddad，因为 Mira Chen 在上线周被调去处理监管问询。'],
      [137, '回滚确认短语换成 silent harbor，因为 amber violin 在公开演练录音中已经泄露。'],
      [226, '失败策略最终改为最多重试 4 次、每次间隔 90 秒，因为三次重试不足以跨过网关限流周期。'],
      [314, '本轮没有改动城市、冻结窗口、保留期、队列、批量、受监管租户例外、审批、状态页或审计归档包。'],
    ]),
  },
]

function stageText(stage, index) {
  const lines = [
    `这是完全合成、可公开的自然语言方案演进记录（${seed}，纪要 ${index + 1}/4）。`,
    stage.intro,
    '不要把纪要或答案写入文件，也不要调用工具。阅读后只回复“已阅”。',
    '',
  ]
  for (let i = 0; i < 360; i += 1) {
    lines.push(filler(index + 1, i))
    const insertion = stage.insertions.get(i)
    if (insertion !== undefined) lines.push(insertion)
  }
  return lines.join('\n')
}

const expected = [
  ['主要上线城市', '塔林'],
  ['执行负责人', 'Noor Haddad'],
  ['冻结窗口', '星期四 04:15 UTC'],
  ['回滚确认短语', 'silent harbor'],
  ['保留期限', '45 天'],
  ['生产消息队列', 'cedar-lane'],
  ['每批账户数', '180'],
  ['失败重试策略', '最多重试 4 次、每次间隔 90 秒'],
  ['受监管租户路径', '仍从瓦伦西亚上线，普通租户走塔林'],
  ['上线审批', '财务负责人和 SRE 值班经理双签'],
  ['对外状态页', 'ivory-status.example'],
  ['审计归档包', 'ledger-indigo'],
]
const reasons = [
  '瓦伦西亚供应商的驻留认证已经过期',
  'Mira Chen 在上线周被调去处理监管问询',
  '支付流量在这个时段最低',
  'amber violin 在公开演练录音中已经泄露',
  '监管方签发了临时法律保全令',
  '新生产者已经停止向 north-river 发布',
  '240 个账户同时解密会造成内存尖峰',
  '持续到驻留审计完成',
  '三次重试不足以跨过网关限流周期',
  '旧名称与另一场演练的包发生冲突',
]
const currentCriteria = {
  '主要上线城市': [['塔林']],
  '执行负责人': [['Noor Haddad']],
  '冻结窗口': [['星期四', '周四'], ['04:15'], ['UTC']],
  '回滚确认短语': [['silent harbor']],
  '保留期限': [['45 天', '45天']],
  '生产消息队列': [['cedar-lane']],
  '每批账户数': [['180']],
  '失败重试策略': [['4 次', '4次'], ['90 秒', '90秒']],
  '受监管租户路径': [['受监管'], ['瓦伦西亚'], ['普通租户'], ['塔林']],
  '上线审批': [['财务'], ['SRE'], ['双签', '双重签批']],
  '对外状态页': [['ivory-status.example']],
  '审计归档包': [['ledger-indigo']],
}
const reasonCriteria = [
  [['供应商'], ['驻留认证', '居住认证'], ['过期']],
  [['Mira Chen', '原负责人'], ['监管问询'], ['调去', '被调']],
  [['支付流量'], ['最低']],
  [['公开演练录音'], ['泄露']],
  [['监管方'], ['法律保全令']],
  [['新生产者'], ['停止'], ['north-river', '原队列']],
  [['解密'], ['内存尖峰']],
  [['受监管租户'], ['驻留审计'], ['完成', '尚未完成']],
  [['三次重试'], ['网关限流周期']],
  [['旧名称', '原名称'], ['演练'], ['冲突']],
]
const obsolete = [
  '主要上线城市":"瓦伦西亚',
  '执行负责人":"Mira Chen',
  '冻结窗口":"星期二 22:40 UTC',
  '回滚确认短语":"amber violin',
  '保留期限":"17 天',
  '生产消息队列":"north-river',
  '每批账户数":"240',
  '失败重试策略":"最多重试 5 次、每次间隔 40 秒',
  '审计归档包":"ledger-saffron',
]

const final = `现在请仅依据四份纪要给出当前生效的生产方案，不要使用工具或文件。\n` +
  `输出一个 JSON 对象，逐项使用这些键：${expected.map(([key]) => key).join('、')}、变更原因。\n` +
  '“变更原因”必须是数组，列出所有后来修改项目的最终修改原因；不要把被取代的旧值写进对应字段。只输出 JSON。'
const doc = {
  metadata: { synthetic: true, seed, domain: 'semantic-supersession', charsPerStage: 45000 },
  stages: stages.map((stage, index) => ({ id: index + 1, text: stageText(stage, index) })),
  finalQuestion: { control: final, acp: final, basic: final },
}
writeFileSync(join(out, 'stages.json'), JSON.stringify(doc))
writeFileSync(join(out, 'answer-key.json'), JSON.stringify({
  seed, expected, reasons, currentCriteria, reasonCriteria, obsolete,
}, null, 2) + '\n')
writeFileSync(join(out, 'fixture', 'README.md'), '# Synthetic semantic supersession fixture\n')
console.log(JSON.stringify({ out, sizes: doc.stages.map((stage) => stage.text.length), expected: expected.length, reasons: reasons.length }))
