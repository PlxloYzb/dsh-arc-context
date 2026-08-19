#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const seed = process.argv[2] ?? 'semantic-holdout-02'
const out = resolve(process.argv[3] ?? join('semantic-supersession', seed))
mkdirSync(join(out, 'fixture'), { recursive: true })
const hash = (value) => createHash('sha256').update(`${seed}:${value}`).digest('hex').slice(0, 16)
const topics = ['capacity', 'support', 'contract', 'network', 'audit', 'billing', 'training', 'dashboard']
const filler = (stage, index) => `Archive heartbeat ${index}: ${topics[(index + stage) % topics.length]} and ${topics[(index * 3 + stage) % topics.length]} were reviewed under trace ${hash(`${stage}:${index}`)}. This recurring heartbeat is background only and never changes the launch policy.`
const stages = [
  new Map([
    [31, 'The launch country is Portugal because the original residency contract covers that jurisdiction.'],
    [84, 'Aisha Bell owns execution and chairs the live coordination bridge.'],
    [137, 'The freeze window is Monday 03:10 UTC, selected around the original usage forecast.'],
    [191, 'The spoken rollback phrase is glass orchard.'],
    [244, 'Raw requests and audit trails remain available for 21 days.'],
    [297, 'Production messages use the marble-path queue.'],
    [351, 'A worker decrypts 144 accounts per batch.'],
    [404, 'A failed batch retries twice with 120 seconds between attempts.'],
    [458, 'There is no country-specific tenant exception in the first plan.'],
    [521, 'Launch requires signatures from the privacy lead and the on-call SRE.'],
  ]),
  new Map([
    [57, 'The freeze window moves to Wednesday 05:45 UTC because telemetry shows the weekly usage trough there.'],
    [173, 'Retention increases to 38 days after counsel issues a litigation hold.'],
    [286, 'The batch size falls to 72 accounts because parallel decryption at 144 exhausted worker memory.'],
    [399, 'Canadian regulated tenants continue through Montreal while the PIPEDA residency audit remains open; all other tenants still launch from Portugal.'],
    [516, 'Country, owner, rollback phrase, queue, retry policy, and approval signatures remain unchanged in this revision.'],
  ]),
  new Map([
    [68, 'Tomas Varga replaces Aisha Bell as execution owner because Aisha is assigned to an unrelated priority incident during launch week.'],
    [224, 'The rollback phrase changes to winter compass because glass orchard appeared in a public drill transcript.'],
    [381, 'The final failure policy is three retries separated by 75 seconds because two attempts cannot span the gateway rate-limit interval.'],
    [537, 'This final revision does not alter country, freeze window, retention, queue, batch size, Canadian exception, or approval signatures.'],
  ]),
]
const texts = stages.map((insertions, stage) => {
  const lines = [
    `Synthetic public policy narrative (${seed}, memo ${stage + 1}/3).`,
    stage === 0 ? 'This memo establishes the first plan.' : 'Later language supersedes conflicting earlier language; unmentioned terms remain active.',
    'Do not use tools or files. Read this memo and reply only ACK.',
    '',
  ]
  for (let i = 0; i < 600; i += 1) {
    lines.push(filler(stage + 1, i))
    if (insertions.has(i)) lines.push(insertions.get(i))
  }
  return lines.join('\n')
})
const expected = [
  ['launchCountry', 'Portugal'], ['executionOwner', 'Tomas Varga'],
  ['freezeWindow', 'Wednesday 05:45 UTC'], ['rollbackPhrase', 'winter compass'],
  ['retention', '38 days'], ['queue', 'marble-path'], ['batchSize', '72'],
  ['retryPolicy', 'three retries separated by 75 seconds'],
  ['regulatedException', 'Canadian regulated tenants continue through Montreal while all other tenants launch from Portugal'],
  ['approvals', 'privacy lead and on-call SRE'],
]
const currentCriteria = {
  launchCountry: [['Portugal']], executionOwner: [['Tomas Varga']],
  freezeWindow: [['Wednesday'], ['05:45'], ['UTC']], rollbackPhrase: [['winter compass']],
  retention: [['38'], ['days']], queue: [['marble-path']], batchSize: [['72']],
  retryPolicy: [['three retries', '3 retries'], ['75 seconds', '75-second']],
  regulatedException: [['Canadian'], ['Montreal'], ['Portugal']],
  approvals: [['privacy lead'], ['on-call SRE']],
}
const reasons = [
  'weekly usage trough', 'litigation hold', 'parallel decryption exhausted worker memory',
  'PIPEDA residency audit remains open', 'priority incident during launch week',
  'public drill transcript', 'gateway rate-limit interval',
]
const reasonCriteria = reasons.map((reason) => [[reason]])
reasonCriteria[2] = [['Parallel decryption', 'parallel decryption'], ['exhausted'], ['worker memory']]
const final = 'Return the currently effective plan from all three memos as one JSON object using exactly these keys: '
  + `${expected.map(([key]) => key).join(', ')}, changeReasons. `
  + 'changeReasons must list every final reason for a changed item. Do not use tools or files; output JSON only.'
writeFileSync(join(out, 'stages.json'), JSON.stringify({
  metadata: { synthetic: true, seed, domain: 'semantic-supersession-holdout' },
  stages: texts.map((text, index) => ({ id: index + 1, text })),
  finalQuestion: { control: final, acp: final, basic: final },
}))
writeFileSync(join(out, 'answer-key.json'), JSON.stringify({
  seed, expected, reasons, currentCriteria, reasonCriteria, obsolete: [],
}, null, 2) + '\n')
writeFileSync(join(out, 'fixture', 'README.md'), '# Synthetic semantic holdout\n')
console.log(JSON.stringify({ out, sizes: texts.map((text) => text.length) }))
