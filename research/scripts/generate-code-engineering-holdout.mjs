#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const seed = process.argv[2] ?? 'code-seed-01'
const root = resolve(process.argv[3] ?? './work/context-governor-research/code-engineering-holdout')
const charsPerStage = Number(process.argv[4] ?? 80_000)

function proof(label) {
  const hex = createHash('sha256').update(`${seed}\0${label}`).digest('hex').toUpperCase()
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}`
}

function filler(stage, target) {
  const rows = []
  let length = 0
  for (let row = 1; length < target; row += 1) {
    const trace = createHash('sha256').update(`${seed}:${stage}:${row}`).digest('hex').slice(0, 12)
    const text = `CI_ARCHIVE stage=${stage} row=${String(row).padStart(5, '0')} trace=${trace} `
      + `job=lint-${row % 17} file=vendor/generated/module-${row % 97}.js status=passed `
      + 'amber birch cobalt delta ember fjord granite harbor iris juniper kinetic lunar\n'
    rows.push(text)
    length += text.length
  }
  return rows.join('').slice(0, target)
}

const tasks = [
  {
    symbol: 'normalizeBranch',
    command: 'node --test --test-name-pattern=normalizeBranch',
    instruction: '实现 normalizeBranch(name)：trim、转小写、连续空白或下划线折叠为一个连字符；必须保留斜杠；空结果抛出 ERR_EMPTY_BRANCH。',
    records: [
      ['CONSTRAINT', 'C1', 'slash-separated release branch segments must remain separated by slash'],
      ['DECISION', 'D1', 'lowercase normalization happens before whitespace and underscore collapse'],
      ['INVARIANT', 'I1', 'an empty normalized branch throws ERR_EMPTY_BRANCH'],
      ['FILE_ANCHOR', 'F1', 'src/release-policy.js owns normalizeBranch'],
      ['TEST_ORACLE', 'T1', 'Release_Candidate / Hot Fix becomes release-candidate-/-hot-fix'],
      ['ROLLBACK', 'B1', 'rejection must not return a partially normalized branch'],
    ],
  },
  {
    symbol: 'retryDelay',
    command: 'node --test --test-name-pattern=retryDelay',
    instruction: '实现 retryDelay(attempt)：只接受整数 0..5，按 250 * 2^attempt 计算并封顶 4000，不加 jitter；非法值抛出 ERR_RETRY_ATTEMPT。',
    records: [
      ['REQUIREMENT', 'C2', 'retry attempt is an integer in the inclusive range zero through five'],
      ['DECISION', 'D2', 'the backoff remains deterministic and contains no jitter'],
      ['INVARIANT', 'I2', 'the delay never exceeds four thousand milliseconds'],
      ['SYMBOL_ANCHOR', 'F2', 'retryDelay remains a named export of src/release-policy.js'],
      ['ERROR_FINGERPRINT', 'T2', 'invalid retry input is ERR_RETRY_ATTEMPT'],
      ['ROLLBACK', 'B2', 'do not introduce timers or asynchronous state'],
    ],
  },
  {
    symbol: 'canDeploy',
    command: 'node --test --test-name-pattern=canDeploy',
    instruction: '实现 canDeploy(input)：production 只允许 main、testsPassed=true、approvals>=2；staging 允许任意非空 branch、testsPassed=true、approvals>=1；其他环境返回 false。',
    records: [
      ['CONSTRAINT', 'C3', 'production deployment is restricted to the main branch'],
      ['DECISION', 'D3', 'unknown environments return false instead of throwing'],
      ['INVARIANT', 'I3', 'testsPassed must be true in every deployable environment'],
      ['FILE_ANCHOR', 'F3', 'src/release-policy.js owns canDeploy'],
      ['TEST_ORACLE', 'T3', 'staging requires one approval while production requires two'],
      ['ROLLBACK', 'B3', 'do not weaken production rules to match staging'],
    ],
  },
  {
    symbol: 'redactToken',
    command: 'node --test --test-name-pattern=redactToken',
    instruction: '实现 redactToken(text)：仅把恰好 dsk_ 加 12 个 ASCII 字母数字的 token 替换为 dsk_[REDACTED]，全局替换，不能改动相似但长度不同的字符串。',
    records: [
      ['REQUIREMENT', 'C4', 'redaction matches dsk_ followed by exactly twelve ASCII alphanumerics'],
      ['DECISION', 'D4', 'replacement is the literal dsk_[REDACTED] marker'],
      ['INVARIANT', 'I4', 'all matching tokens in one string are redacted'],
      ['SYMBOL_ANCHOR', 'F4', 'redactToken remains synchronous and pure'],
      ['ERROR_FINGERPRINT', 'T4', 'lookalikes with eleven or thirteen suffix characters stay unchanged'],
      ['ROLLBACK', 'B4', 'do not redact arbitrary dsk_ prefixes'],
    ],
  },
]

const expected = []
const stages = tasks.map((task, taskIndex) => {
  const stage = taskIndex + 1
  const body = filler(stage, charsPerStage)
  const cuts = Array.from({ length: task.records.length + 1 }, (_, index) => Math.floor(body.length * index / task.records.length))
  let archive = ''
  for (let index = 0; index < task.records.length; index += 1) {
    const [kind, id, statement] = task.records[index]
    const value = proof(id)
    expected.push({ key: id, value, kind, statement, stage })
    // Every record owns a complete line. Arbitrary character cuts in the CI
    // filler must never glue an oracle to the preceding log line.
    archive += `\n${kind} ${id}: ${statement}; proof=${value}\n`
    archive += `${body.slice(cuts[index], cuts[index + 1])}\n`
  }
  return {
    id: stage,
    text: [
      `这是完全合成、可公开的代码工程 holdout（${seed}，阶段 ${stage}/4）。`,
      '使用工具修改当前 fixture；不要把 proof 值或本段档案写入任何文件。',
      task.instruction,
      `完成后运行 ${task.command}，然后只简短报告该阶段结果。`,
      '',
      archive,
    ].join('\n'),
  }
})

const byKey = Object.fromEntries(expected.map((item) => [item.key, item.value]))
const derived = {
  X1: `${byKey.C1}.${byKey.D4}`,
  X2: `${byKey.I2}/${byKey.T3}`,
  X3: `${byKey.F1}:${byKey.F4}:${byKey.B3}`,
  X4: `${byKey.D1}-${byKey.D2}-${byKey.D3}-${byKey.D4}`,
}
const finalPrompt = [
  '禁止调用任何工具、文件或外部数据源。仅根据当前会话回答。',
  '返回一个 JSON 对象，不要解释。proofs 包含下列 24 个 key 的逐字 proof；derived 按规则拼接。',
  `keys=${expected.map((item) => item.key).join(',')}`,
  'X1=C1 + "." + D4',
  'X2=I2 + "/" + T3',
  'X3=F1 + ":" + F4 + ":" + B3',
  'X4=D1 + "-" + D2 + "-" + D3 + "-" + D4',
].join('\n')

const dir = join(root, seed)
const fixture = join(dir, 'fixture')
mkdirSync(join(fixture, 'src'), { recursive: true })
mkdirSync(join(fixture, 'test'), { recursive: true })
writeFileSync(join(fixture, 'package.json'), JSON.stringify({
  name: 'synthetic-release-policy-holdout',
  private: true,
  type: 'module',
  scripts: { test: 'node --test' },
}, null, 2) + '\n')
writeFileSync(join(fixture, 'src/release-policy.js'), `export function normalizeBranch(_name) {\n  throw new Error('TODO_NORMALIZE_BRANCH')\n}\n\nexport function retryDelay(_attempt) {\n  throw new Error('TODO_RETRY_DELAY')\n}\n\nexport function canDeploy(_input) {\n  throw new Error('TODO_CAN_DEPLOY')\n}\n\nexport function redactToken(_text) {\n  throw new Error('TODO_REDACT_TOKEN')\n}\n`)
writeFileSync(join(fixture, 'test/release-policy.test.js'), `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { normalizeBranch, retryDelay, canDeploy, redactToken } from '../src/release-policy.js'\n\ntest('normalizeBranch', () => {\n  assert.equal(normalizeBranch(' Release_Candidate / Hot Fix '), 'release-candidate-/-hot-fix')\n  assert.equal(normalizeBranch('feature/API_V2'), 'feature/api-v2')\n  assert.throws(() => normalizeBranch(' ___ '), /ERR_EMPTY_BRANCH/)\n})\n\ntest('retryDelay', () => {\n  assert.deepEqual([0, 1, 2, 3, 4, 5].map(retryDelay), [250, 500, 1000, 2000, 4000, 4000])\n  assert.throws(() => retryDelay(1.5), /ERR_RETRY_ATTEMPT/)\n  assert.throws(() => retryDelay(6), /ERR_RETRY_ATTEMPT/)\n})\n\ntest('canDeploy', () => {\n  assert.equal(canDeploy({ env: 'production', branch: 'main', testsPassed: true, approvals: 2 }), true)\n  assert.equal(canDeploy({ env: 'production', branch: 'feature/x', testsPassed: true, approvals: 9 }), false)\n  assert.equal(canDeploy({ env: 'staging', branch: 'feature/x', testsPassed: true, approvals: 1 }), true)\n  assert.equal(canDeploy({ env: 'staging', branch: '', testsPassed: true, approvals: 1 }), false)\n  assert.equal(canDeploy({ env: 'qa', branch: 'main', testsPassed: true, approvals: 9 }), false)\n})\n\ntest('redactToken', () => {\n  assert.equal(redactToken('a dsk_Ab12Cd34Ef56 b dsk_Z9Y8X7W6V5U4'), 'a dsk_[REDACTED] b dsk_[REDACTED]')\n  assert.equal(redactToken('dsk_Ab12Cd34Ef5 dsk_Ab12Cd34Ef567'), 'dsk_Ab12Cd34Ef5 dsk_Ab12Cd34Ef567')\n})\n`)
writeFileSync(join(dir, 'stages.json'), JSON.stringify({
  metadata: { synthetic: true, seed, domain: 'code-engineering', charsPerStage },
  stages,
  finalQuestion: { control: finalPrompt, acp: finalPrompt, basic: finalPrompt },
}, null, 2) + '\n')
writeFileSync(join(dir, 'answer-key.json'), JSON.stringify({ seed, expected, derived }, null, 2) + '\n')
console.log(dir)
