import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const research = fileURLToPath(new URL('..', import.meta.url))
const root = fileURLToPath(new URL('../..', import.meta.url))
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const result = (name) => json(join(research, 'results', name))

const readiness = await result('PRODUCT_READINESS_RESULTS.json')
const code = readiness.codeEngineeringPairedSeed02
assert.equal(code.governor.totalPromptTokens,
  code.governor.usage.uncachedInputTokens + code.governor.usage.cacheReadTokens)
assert.equal(code.basicAllIn.totalPromptTokens,
  code.basicAllIn.usage.uncachedInputTokens + code.basicAllIn.usage.cacheReadTokens)
assert.equal(code.governor.quality.exact, '24/24')
assert.equal(code.basicAllIn.quality.exact, '6/24')

const semantic = readiness.semanticSupersessionPairedSeed01
assert.equal(semantic.governorV2.quality.current, '12/12')
assert.equal(semantic.governorV2.quality.rationale, '10/10')
assert.equal(semantic.governorV2.quality.obsoleteLeakage, 0)
assert.equal(semantic.basicAllIn.totalPromptTokens,
  semantic.basicAllIn.usage.uncachedInputTokens + semantic.basicAllIn.usage.cacheReadTokens)
assert.equal(semantic.governorV2.totalPromptTokens,
  semantic.governorV2.usage.uncachedInputTokens + semantic.governorV2.usage.cacheReadTokens)
assert.equal(readiness.semanticIndependentHoldout02.sequentialStopSatisfied, true)
assert.equal(readiness.liveOutputIntent384K.requestedMaxTokens, 393216)
assert.equal(readiness.liveOutputIntent384K.errors, 0)
assert.deepEqual(readiness.deterministicReleaseGate.tests, { passed: 134, failed: 0 })


const presetBridge = await result('preset-bridge-results.json')
assert.equal(presetBridge.targetHost, '@deepseek-ai/dsh 0.1.0-rc.7 (published npm line; no host patches)')
assert.deepEqual(presetBridge.deterministicGate, {
  ...presetBridge.deterministicGate,
  passed: 137,
  failed: 0,
  bridgeIntegrationTests: 6,
})
assert.equal(presetBridge.deterministicGate.bridgeIntegrationAgainst.includes('cordis-plugin-loader@1.0.2'), true)
assert.equal(presetBridge.mechanism.ordering.includes('two sequential Include updates'), true)
const live = presetBridge.liveWebTakeover
assert.equal(live.takeover.acpStatusToolResult.backendOwnership, 'ACTIVE')
assert.equal(live.takeover.acpStatusToolResult.resolvedCompactionBackend, 'dsh-arc-context')
assert.equal(live.uninstall.newSessionAfterRestart.includes('NO ACP TOOLS'), true)
assert.equal(live.uninstall.oldArcSessionReadableUnderBasic.includes('4141 events'), true)
assert.equal(live.presetFileIntegrity.standardPresetSha256, '4edeb70bf995a0324f234e2adf8db6b394c3d26e1bcb76821976950fb0237bc9')
assert.equal(live.modelAuthoredCompress.durableEvents.length, 3)
assert.equal(live.presetLessHost.afterBeta2.includes('real GLM-5.2 headless turn completed'), true)

const resume = await result('uninstall-resume-results.json')
assert.equal(resume.projectionsUnderBasic.projectedTokens, 35689)
assert.equal(resume.projectionsUnderBasic.messageTokens, 23362)
assert.equal(resume.resumedTurn.completed, true)
assert.equal(resume.resumedTurn.postTurnProjections.projectedTokens, 36127)
assert.equal(resume.whyItHolds.includes('official session-log event vocabulary'), true)

const smoke = await result('bench/smoke-beta4-v2-seed1-2026-08-17T17-50-38-339Z.json')
assert.equal(smoke.result.recall.score, '22/22')
assert.equal(smoke.result.recall.trapLeaks.length, 0)
assert.equal(smoke.result.ledger.totalPromptTokens,
  smoke.result.ledger.uncachedInputTokens + smoke.result.ledger.cacheReadTokens)

const rq2 = await result('rq2-cache-economics-final.json')
assert.equal(rq2.invalidateModel.evidence.headCompress.spikeTokens, 21282)
assert.equal(rq2.invalidateModel.evidence.headCompress.shadowedTokens, 3034)
assert.equal(rq2.invalidateModel.evidence.middleCompress.spikeTokens, 10297)
assert.equal(rq2.invalidateModel.evidence.middleCompress.shadowedTokens, 2376)
assert.equal(rq2.invalidateModel.evidence.noCompressionSteadyState.uncachedPerCall, 100.8)
assert.equal(rq2.batching.evidence.batch2OneCallTwoRanges.spikeTokensTotal, 19502)
assert.equal(rq2.batching.evidence.sequent2TwoCalls.spikeTokensTotal, 36127)
assert.equal(rq2.breakEven.head.rawHorizonCalls, 7)
assert.equal(rq2.breakEven.middle.rawHorizonCalls, 4.3)
assert.equal(rq2.invalidateModel.hypothesisVerdict.includes('FALSIFIED IN DIRECTION'), true)
assert.equal(rq2.batching.hypothesisVerdict.includes('CONFIRMED'), true)

// RQ3+RQ8 recall matrix: the results file must stay consistent with the eight
// per-session bench reports it summarizes (strict scores, ledger sums).
const rq3 = await result('rq3-recall-results.json')
assert.equal(rq3.costLedger.modelCalls, 87)
assert.equal(rq3.costLedger.totalsAll8Sessions.totalPromptTokens,
  rq3.costLedger.totalsAll8Sessions.uncachedInputTokens + rq3.costLedger.totalsAll8Sessions.cacheReadTokens)
assert.equal(rq3.matrix['zh-blind-1'].strict, '22/22')
assert.equal(rq3.matrix['en-blind-1'].strict, '16/22')
assert.equal(rq3.matrix['en-recovery-2'].strict, '15/21')
assert.equal(rq3.matrix['zh-recovery-2'].strict, '18/21')
for (const [arm, cell] of Object.entries(rq3.matrix)) {
  const [r, t] = cell.strict.split('/').map(Number)
  assert.equal(cell.formAudited, `${t}/${t}`, `${arm}: form-audited must be full`)
  assert.equal(cell.strictRate, Number((r / t).toFixed(4)), `${arm}: strict rate arithmetic`)
}
assert.equal(rq3.blindRecall.pooled.en.strict, '34/43')
assert.equal(rq3.blindRecall.pooled.zh.strict, '40/43')
assert.equal(rq3.recoveryRecall.pooled.en.strict, '37/43')
assert.equal(rq3.recoveryRecall.pooled.zh.strict, '40/43')
assert.equal(rq3.recoveryRecall.toolCost.searchContextCalls, 8)
assert.equal(rq3.recoveryRecall.toolCost.decompressCalls, 9)
assert.deepEqual(rq3.shadowingEvidence.perSessionLedgerShadowedTokens['en-blind-1'], 19547)
assert.equal(rq3.phase2Recommendation.recommendation.includes('DO NOT BUILD'), true)
assert.equal(rq3.rq3Status, 'answered-phase1')
assert.equal(rq3.localeGapRQ8.hypothesisVerdict.includes('FALSIFIED'), true)
// RQ1-closure task A: form-contract v2 rescore (dual caliber). The strict
// caliber must still reproduce the recorded matrix; the loose caliber and
// three-class trap outcome are the new duals (original fields untouched).
assert.equal(rq3.rescored.scorer.includes('form-contract v2'), true)
assert.equal(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(rq3.rescored.rescoredAt), true)
for (const [arm, cell] of Object.entries(rq3.rescored.perArm)) {
  assert.equal(cell.strict, rq3.matrix[arm].strict, `${arm}: rescore strict must match the recorded matrix`)
  const [looseHit, total] = cell.loose.split('/').map(Number)
  assert.equal(looseHit, total, `${arm}: loose (information-level) recall must be full`)
  assert.equal(cell.forms.miss, 0, `${arm}: no information loss beyond answer form`)
  assert.equal(cell.forms.full + cell.forms.bare, total, `${arm}: form histogram arithmetic`)
}
for (const localeMode of ['en-blind', 'zh-blind', 'en-recovery', 'zh-recovery']) {
  assert.equal(rq3.rescored.pooled[localeMode].loose, '43/43')
  const [strictHit, total] = rq3.rescored.pooled[localeMode].strict.split('/').map(Number)
  assert.equal(rq3.rescored.pooled[localeMode].strictRate, Number((strictHit / total).toFixed(4)),
    `${localeMode}: pooled strict-rate arithmetic`)
}
assert.equal(rq3.rescored.pooled['en-blind'].strict, '34/43')
assert.equal(rq3.rescored.pooled['zh-recovery'].strict, '40/43')
assert.equal(rq3.rescored.trapOutcome.quotedRefusedArms.includes('zh-recovery-1'), true)
assert.equal(rq3.rescored.trapOutcome.compliedArms.length, 0)
{
  const benchDir = join(research, 'results', 'bench')
  const sessionFiles = (await readdir(benchDir)).filter((f) => /^rq3-(en|zh)-(blind|recovery)-\d.*\.json$/.test(f))
  assert.equal(sessionFiles.length, 8, 'eight per-session RQ3 reports')
  let uncached = 0
  let cacheRead = 0
  let output = 0
  let calls = 0
  for (const f of sessionFiles) {
    const s = await json(join(benchDir, f))
    if (s.error) continue
    assert.equal(rq3.matrix[s.arm].strict, s.result.recall, `${s.arm}: matrix matches session report`)
    assert.equal(s.compress.rangesLanded, 3, `${s.arm}: all three instructed ranges landed`)
    uncached += s.result.ledger.uncachedInputTokens
    cacheRead += s.result.ledger.cacheReadTokens
    output += s.result.ledger.outputTokens
    calls += s.result.calls
  }
  assert.deepEqual({ uncachedInputTokens: uncached, cacheReadTokens: cacheRead, outputTokens: output, modelCalls: calls },
    { uncachedInputTokens: rq3.costLedger.totalsAll8Sessions.uncachedInputTokens,
      cacheReadTokens: rq3.costLedger.totalsAll8Sessions.cacheReadTokens,
      outputTokens: rq3.costLedger.totalsAll8Sessions.outputTokens,
      modelCalls: rq3.costLedger.modelCalls })
}

// RQ1-closure task C: projection subtraction under autoNudge. The nudge
// pressure source must be pinned to the host projection, all post-compression
// emergency nudges must be over-pressure artifacts under the conservative
// correction, and the classification must be the recorded product defect.
const proj = await result('projection-subtraction-results.json')
assert.equal(proj.judgment.cClassification.includes('nudge-overpressure product defect'), true)
assert.equal(proj.setup.patch.includes('autoNudge true'), true)
assert.equal(proj.compression.preCompressProjected, 25510)
assert.equal(proj.compression.ledgerShadowedTokens, 5638)
assert.equal(proj.judgment.aProjectionDroppedAfterCompression > 0, true)
assert.equal(proj.postCompressionNudgeAudit.summary.postCompressionNudges, 6)
assert.equal(proj.postCompressionNudgeAudit.summary.postCompressionEmergencyArtifacts, 6)
assert.equal(proj.postCompressionNudgeAudit.summary.wouldNotFireAtAll, 1)
assert.equal(proj.postCompressionNudgeAudit.releaseCounterfactual.postCompressionEmergencyNudgesWithFix, 0)
assert.equal(proj.postCompressionNudgeAudit.releaseCounterfactual.preventedEmergencyArtifacts, 6)
assert.equal(proj.postCompressionNudgeAudit.releaseCounterfactual.postCompressionNudgesSuppressedWithFix, 1)
assert.equal(proj.postCompressionNudgeAudit.releaseCounterfactual.postCompressionNormalNudgesWithFix, 5)
assert.equal(proj.setup.budget.cap >= proj.setup.budget.used, true)

// Release verification: the real beta.6 run is bounded to 15 calls. Its
// unusually long model tool loop still has no post-compression over-pressure
// artifact: each emergency reading remains above 85% after ledger subtraction,
// and arc_status reports the same corrected reader.
const nudgeFix = await result('nudge-overpressure-fix-verification.json')
assert.equal(nudgeFix.setup.arcVersion, '0.2.0-beta.6 via bridge')
assert.equal(nudgeFix.setup.budget.used <= nudgeFix.setup.budget.cap, true)
assert.equal(nudgeFix.setup.budget.cap, 15)
assert.equal(nudgeFix.compression.shadowedTokenCount, 5125)
assert.equal(nudgeFix.postCompressionNudges.length, 7)
assert.equal(nudgeFix.verification.postCompressionEmergencyNudges, 6)
assert.equal(nudgeFix.verification.allPostCompressionEmergencyNudgesRemainAboveEffective85Pct, true)
assert.equal(nudgeFix.verification.arcStatusAndNudgeShareCompressionAwareReader, true)
assert.equal(nudgeFix.arcStatus.observedEffectiveTokens, 73254)

// RQ7 pre-OSS adversarial gate: every fixture marker is classified by the
// shared scorer, retrieval is explicitly archive-framed, and compliance is a
// release blocker.
const rq7 = await result('rq7-adversarial-results.json')
assert.equal(rq7.setup.arcVersion, '0.2.0-beta.7 via bridge')
assert.equal(rq7.setup.variants, 18)
assert.equal(rq7.setup.budget.used <= rq7.setup.budget.cap, true)
assert.equal(rq7.setup.budget.cap, 30)
assert.equal(rq7.compactions.length, 1)
assert.equal(rq7.retrieval.searchAndDecompressFramed, true)
assert.equal(rq7.retrieval.archiveBoundaryCount, 2)
assert.deepEqual(rq7.summaryMarkerLeaks, [])
assert.equal(rq7.scoring.trapClassification.length, 18)
assert.equal(rq7.scoring.trapClassification.every((trap) => trap.cls !== 'complied'), true)
assert.equal(rq7.verdict.complied, 0)
assert.equal(rq7.verdict.pass, true)

// RQ5 four-arm measurement: this is deliberately a budget-capped partial
// record, not a manufactured success.  The persistent-log numbers, prompt
// contamination guard, and explicit missing P-quality comparator must remain
// truthful and arithmetically coherent.
const rq5 = await result('rq5-compliance-results.json')
assert.equal(rq5.completion.status, 'partial')
assert.deepEqual(Object.keys(rq5.arms).sort(), ['G80', 'G88', 'N', 'P'])
assert.equal(rq5.compliance.normal.eligible, 4)
assert.equal(rq5.compliance.normal.complied, 1)
assert.equal(rq5.compliance.normal.rate, 0.25)
assert.equal(rq5.compliance.emergency.eligible, 3)
assert.equal(rq5.compliance.emergency.complied, 2)
assert.equal(rq5.compliance.emergency.rate, 2 / 3)
assert.deepEqual(rq5.latency.samples, [1, 0, 0])
assert.equal(rq5.decisionTwo.verdict, 'underdetermined-low-n')
assert.equal(rq5.decisionTwo.totalSpontaneousCalls, 1)
assert.equal(rq5.decisionTwo.partialCalls, 1)
assert.deepEqual(rq5.decisionTwo.positions, { head: 1 })
assert.equal(rq5.governorComparison.G80.earlyArchiveTriggerCount, 2)
assert.equal(rq5.governorComparison.G88.earlyArchiveTriggerCount, 2)
assert.equal(rq5.quality.proactiveP, null)
assert.equal(rq5.quality.comparison.includes('not estimable'), true)
assert.equal(rq5.arms.P.quality.available, false)
assert.equal(rq5.costLedger.totalModelCalls, 59)
assert.equal(rq5.costLedger.cap, 60)
assert.equal(rq5.costLedger.withinBudget, true)
assert.equal(rq5.costLedger.discardedSetupOrIncompleteCalls, 29)
assert.equal(rq5.costLedger.totals.totalPromptTokens,
  rq5.costLedger.totals.uncachedInputTokens + rq5.costLedger.totals.cacheReadTokens)
assert.equal(rq5.verification.allFourArmsPresent, true)
assert.equal(rq5.verification.naturalPromptAuditClean, true)
assert.equal(rq5.verification.qualityDualRecordedOrExplicitlyUnavailable, true)

// RQ5b completion: the first-round object above stays byte-for-byte in its
// original fields, while phase2 records the zero-call Governor audit, the P
// protocol's second (interface) failure, and the capped N expansion honestly.
const rq5Audit = await result('rq5-governor-archive-audit.json')
assert.equal(rq5Audit.verification.expectedArchiveCount, 4)
assert.equal(rq5Audit.verification.archiveCount, 4)
assert.equal(rq5Audit.verification.zeroModelCalls, true)
assert.equal(rq5Audit.totals.facts, 12)
assert.equal(rq5Audit.totals.verbatim, 12)
assert.equal(rq5Audit.totals.paraphrase, 0)
assert.equal(rq5Audit.totals.lost, 0)
assert.equal(rq5Audit.totals.strictRate, 1)
assert.equal(rq5Audit.totals.looseRate, 1)
assert.deepEqual(rq5Audit.categoryDistribution.numeric, {
  total: 2, verbatim: 2, paraphrase: 0, lost: 0, strictRate: 1, looseRate: 1,
})
assert.equal(rq5.phase2.status, 'complete')
assert.equal(rq5.phase2.phaseOneCanonicalSha256, '3dc292d1078581e126efa563437035d0da217568248edd55df56e79b40ceac60')
assert.equal(rq5.phase2.budget.cap, 45)
assert.equal(rq5.phase2.budget.used, 35)
assert.equal(rq5.phase2.budget.withinCap, true)
assert.equal(rq5.phase2.budget.zeroCallOfflineAudit, true)
assert.equal(rq5.phase2.proactiveP.calls, 10)
assert.equal(rq5.phase2.proactiveP.protocol.pPlantPressure, 15201)
assert.equal(rq5.phase2.proactiveP.protocol.driverSuppliedSequenceNumbers, false)
assert.equal(rq5.phase2.proactiveP.protocol.arcStatusSuggestedRangeTablePresent, false)
assert.equal(rq5.phase2.proactiveP.protocol.failureReason.includes('no permitted range'), true)
assert.equal(rq5.phase2.proactiveP.verification.pSecondFailureLocated, true)
assert.equal(rq5.phase2.nExpansion.reports.length, 3)
assert.equal(rq5.phase2.nExpansion.reports.every((report) => report.promptAudit.forbiddenMatches.length === 0), true)
assert.equal(rq5.phase2.nExpansion.eligibleNudgeCount, 9)
assert.equal(rq5.phase2.nExpansion.targetAtLeast10Met, false)
assert.deepEqual(rq5.phase2.nExpansion.compliance.normal.wilson95, {
  level: 0.95, low: 0.5100999795960008, high: 1,
})
assert.deepEqual(rq5.phase2.nExpansion.compliance.normal.sampleEstimateIfStillCrosses80, {
  total: 16, additional: 12, direction: 'lower-bound-above-80pct', assumption: 'observed rate remains 100.0%',
})
assert.equal(rq5.phase2.decisionTwo.totalSpontaneousCalls, 4)
assert.equal(rq5.phase2.decisionTwo.partialCalls, 4)
assert.deepEqual(rq5.phase2.decisionTwo.positions, { head: 4 })
assert.equal(rq5.phase2.decisionTwo.verdict, 'partial-head-dominant')
assert.equal(rq5.phase2.criterionComparison.branch, 'P-model-summary-unavailable-arc-status-has-no-suggested-range-table')
assert.equal(rq5.phase2.verification.pProtocolConclusionRecorded, true)
assert.equal(rq5.phase2.verification.allNPromptAuditsClean, true)
assert.equal(rq5.phase2.verification.liveBudgetWithinCap, true)
assert.equal(rq5.phase2.verification.originalFieldsPreserved, true)

// RQ1-closure task B: historical reproduction verdicts — the semantic pair
// reproduced within noise, the code pair flipped on cost (honest state).
const repro = await result('rq1-historical-reproduction.json')
assert.equal(repro.verdicts.semantic.verdict, 'reproduced-within-noise')
assert.equal(repro.verdicts.semantic.deltas.uncachedPct, -23.58)
assert.equal(Math.abs(repro.verdicts.semantic.deltas.uncachedPct - repro.verdicts.semantic.recordedDeltas.uncachedPct) <= 10, true)
assert.equal(repro.verdicts.code.verdict, 'direction-flipped')
assert.equal(repro.arms['code-arc'].quality.exactProofs.recalled, 24)
assert.equal(repro.arms['code-arc'].quality.derived.recalled, 4)
assert.equal(repro.arms['code-arc'].projectTests.passed, true)
assert.equal(repro.arms['code-basic'].quality.exactProofs.recalled < 24, true)
assert.equal(repro.arms['semantic-arc'].quality.currentState.recalled, 12)
assert.equal(repro.arms['semantic-basic'].quality.currentState.recalled, 12)
assert.equal(repro.rq1Closure.reproduced, false)
assert.equal(repro.rq1Closure.note.includes('within 1 fact'), true)
for (const arm of ['code-arc', 'code-basic', 'semantic-arc', 'semantic-basic']) {
  const a = repro.arms[arm]
  assert.equal(a.allIn.totalPromptTokens, a.allIn.uncachedInputTokens + a.allIn.cacheReadTokens, `${arm}: all-in arithmetic`)
  assert.equal(a.sessionLoop.totalPromptTokens, a.sessionLoop.uncachedInputTokens + a.sessionLoop.cacheReadTokens, `${arm}: session-loop arithmetic`)
}
assert.equal(repro.budget.totalModelCallsThisCommission, 45)

const preopen = await result('PREOPEN_RELEASE_RESULTS.json')
assert.equal(preopen.deterministicTests, 134)
assert.deepEqual(preopen.repeatedTemplateAndArchiveInjection.v1Counterexample.quality, {
  values: '0/20', dependencies: '0/20', safeFinal: false, injectionStringContamination: true,
})
assert.deepEqual(preopen.repeatedTemplateAndArchiveInjection.v2Fixed.quality, {
  values: '20/20', dependencies: '20/20', safeFinal: true, injectionStringContamination: false,
})
assert.equal(preopen.glm52SemanticPaired.arc.quality.current, '12/12')
assert.equal(preopen.glm52SemanticPaired.basicAllIn.quality.current, '12/12')
assert.equal(preopen.glm52CodeHoldout.v2Fixed.exactProofs.recalled, 24)
assert.equal(preopen.glm52CodeHoldout.v2Fixed.derived.recalled, 4)
assert.equal(preopen.glm52CodeHoldout.v2Fixed.projectTests.passed, true)
assert.equal(preopen.glm52CodeHoldout.basicArmRun, false)
assert.equal(preopen.cleanInstall.freshDshHome, true)
assert.equal(preopen.cleanInstall.profiles.web.boot, true)
assert.equal(preopen.cleanInstall.profiles.web.rootBasicDisabled, true)
assert.equal(preopen.cleanInstall.profiles.headless.rootBasicDisabled, true)
assert.equal(preopen.cleanInstall.presets.audit.anchoredStandard, 'PASS')
assert.equal(preopen.cleanInstall.presets.audit.routerStandard, 'PASS')
assert.equal(preopen.cleanInstall.runtimePeerResolution, 'PASS')

for (const [path, expected, derived] of [
  ['randomized-paired/seed-01/answer-key.json', 48, 3],
  ['randomized-paired/seed-02/answer-key.json', 48, 3],
  ['code-engineering-holdout/code-seed-02/answer-key.json', 24, 4],
]) {
  const key = await json(join(research, 'fixtures', path))
  assert.equal(key.expected.length, expected, `${path}: expected record count`)
  assert.equal(Object.keys(key.derived).length, derived, `${path}: derived record count`)
}

const manifest = await json(join(research, 'EVIDENCE_MANIFEST.json'))
assert.equal(manifest.rawMuxIncluded, false)
for (const run of manifest.runs) {
  if (run.result !== null) await json(join(research, run.result))
}

// RQ6 v3 used the same experiment-only narrowed protection geometry in both
// arms, then landed every paired model-written compression within budget.
const rq6 = await result('rq6-guidance-results.json')
assert.equal(rq6.status, 'answered-compact-guidance-supported')
assert.deepEqual(rq6.v3ControlledCondition, {
  protectedRecentMessages: 0,
  protectedRecentTokens: 1,
  appliedTo: 'both A/full and B/compact arms',
  purpose: 'make a one-turn planted user record eligible for compression',
  productionDifference: { protectedRecentMessages: 5, protectedRecentTokens: 5000 },
  notAProductionRecommendation: true,
})
assert.equal(rq6.offlineAssets.fullGuidanceTokens, 3274)
assert.equal(rq6.offlineAssets.compactGuidanceTokens, 1140)
assert.equal(rq6.coreProtocol.arms.length, 4)
assert.equal(rq6.coreProtocol.allArmsLanded, true)
assert.equal(rq6.coreProtocol.budgetLedger.totalCalls, 24)
assert.equal(rq6.coreProtocol.budgetLedger.withinCap, true)
assert.equal(rq6.quality.differencePercentagePoints, 0)
assert.equal(rq6.criterionComparison.branch, 'difference-below-5pp')
assert.equal(rq6.environmentRestoration.profilePatchRestoredToRQ2Baseline, true)

// RQ4 is intentionally a constrained, non-decision-grade record: the public
// result must retain its budget failure rather than laundering it into a pass,
// while still pinning the observed curve and reversible tier-2 source proof.
const rq4 = await result('rq4-distillation-results.json')
assert.equal(rq4.completion.completeChains, 3)
assert.equal(rq4.costLedger.cap, 40)
assert.equal(rq4.costLedger.used, 52)
assert.equal(rq4.costLedger.withinCap, false)
assert.deepEqual(rq4.curves.tiers.map((tier) => tier.loose), ['44/60', '43/60', '12/60'])
assert.equal(rq4.curves.tiers[2].carrier.shares.indexBearing, 33 / 34)
assert.equal(rq4.decompression.perChain.some((chain) => chain.result === 'pass-full-tier1-range'), true)
assert.equal(rq4.decompression.allTier2RecoverTier1, false)
assert.equal(rq4.decompression.reAssessed.classification, 'P2-measurement-criterion')
assert.equal(rq4.decompression.reAssessed.legacyFieldsRetained, true)
assert.equal(rq4.decompression.reAssessed.allTier2RecoverEffectiveSource, true)
assert.equal(rq4.decompression.reAssessed.curveConclusionChanged, false)
assert.equal(rq4.decompression.perChain.every((chain) => chain.reAssessed.result === 'pass-full-effective-source'), true)
assert.equal(rq4.decompression.perChain.every((chain) => chain.reAssessed.missingRenderableSourceSeqs.length === 0), true)
assert.equal(rq4.criterionComparison.branch, 'confirmed-index-first-candidate')

// RQ2 batch protected-zone fixture: the exported live failure session. Local
// absolute home paths were sanitized at export with a same-length placeholder
// (char counts matter to the replayed threshold/walk arithmetic).
const rq2Fixture = await json(join(research, 'fixtures', 'rq2-batch-live-session.json'))
assert.equal(rq2Fixture.cutSeq, 949)
assert.equal(rq2Fixture.events.length, 949)
assert.equal(rq2Fixture.events[948].event.seq, 948)
assert.equal(rq2Fixture.events[948].event.data.message.content.some(
  (block) => block.type === 'tool-call' && block.name === 'compress'), true)

async function filesUnder(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesUnder(path))
    else output.push(path)
  }
  return output
}

const textExtensions = new Set(['.md', '.mjs', '.mts', '.ts', '.json', '.yml', '.yaml'])
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\/Users\/[A-Za-z0-9._-]+\//,
]
for (const path of await filesUnder(root)) {
  if (!textExtensions.has(extname(path))) continue
  const text = await readFile(path, 'utf8')
  for (const pattern of credentialPatterns) {
    assert.equal(pattern.test(text), false, `${relative(root, path)} matched ${pattern}`)
  }
}

// RQ4b is a zero-product-change mechanism record. Its failed expansion stays
// explicit: a single operational chain cannot be promoted to the bilingual,
// multi-seed decision criterion or silently treated as a release signal.
const rq4b = await result('rq4b-index-charter.json')
assert.equal(rq4b.scope.includes('no src/ changes'), true)
assert.equal(rq4b.mechanism.verdict.includes('re-extracted'), true)
assert.equal(rq4b.mechanism.modelVisibleSurface.includes('checkpoint user message'), true)
assert.equal(rq4b.expansion.budget.capModelCalls, 100)
assert.equal(rq4b.expansion.budget.callsObservedBeforeStop, 27)
assert.equal(rq4b.expansion.budget.forecastForSixCompleteChains > rq4b.expansion.budget.capModelCalls, true)
assert.equal(rq4b.expansion.matrixVerdict, 'not-established-budget-stopped')
assert.equal(rq4b.variantDecision.recommended, 'B-effective-source-index-refresh, conditionally gated by a corrected six-chain rerun.')
assert.equal(rq4b.checks.sourceModified, false)
assert.equal(rq4b.checks.hostStopped, true)

console.log('public evidence verified: arithmetic, quality gates, fixtures, manifest, and hygiene')
