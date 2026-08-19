import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBranch, retryDelay, canDeploy, redactToken } from '../src/release-policy.js'

test('normalizeBranch', () => {
  assert.equal(normalizeBranch(' Release_Candidate / Hot Fix '), 'release-candidate-/-hot-fix')
  assert.equal(normalizeBranch('feature/API_V2'), 'feature/api-v2')
  assert.throws(() => normalizeBranch(' ___ '), /ERR_EMPTY_BRANCH/)
})

test('retryDelay', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(retryDelay), [250, 500, 1000, 2000, 4000, 4000])
  assert.throws(() => retryDelay(1.5), /ERR_RETRY_ATTEMPT/)
  assert.throws(() => retryDelay(6), /ERR_RETRY_ATTEMPT/)
})

test('canDeploy', () => {
  assert.equal(canDeploy({ env: 'production', branch: 'main', testsPassed: true, approvals: 2 }), true)
  assert.equal(canDeploy({ env: 'production', branch: 'feature/x', testsPassed: true, approvals: 9 }), false)
  assert.equal(canDeploy({ env: 'staging', branch: 'feature/x', testsPassed: true, approvals: 1 }), true)
  assert.equal(canDeploy({ env: 'staging', branch: '', testsPassed: true, approvals: 1 }), false)
  assert.equal(canDeploy({ env: 'qa', branch: 'main', testsPassed: true, approvals: 9 }), false)
})

test('redactToken', () => {
  assert.equal(redactToken('a dsk_Ab12Cd34Ef56 b dsk_Z9Y8X7W6V5U4'), 'a dsk_[REDACTED] b dsk_[REDACTED]')
  assert.equal(redactToken('dsk_Ab12Cd34Ef5 dsk_Ab12Cd34Ef567'), 'dsk_Ab12Cd34Ef5 dsk_Ab12Cd34Ef567')
})
