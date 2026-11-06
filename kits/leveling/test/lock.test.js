// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireInstanceLock } from '../src/lock.js'
import { tempDir } from './helpers.js'

describe('instance lock', () => {
  test('a live lock blocks a second process and a stale lock can be taken', () => {
    const dir = tempDir()
    const file = dir.path('instance.lock')
    try {
      const now = { value: 1_000 }
      const first = acquireInstanceLock(file, { now: () => now.value, leaseMs: 500, token: 'a' })
      assert.throws(() => acquireInstanceLock(file, { now: () => now.value, leaseMs: 500, token: 'b' }), (error) => error.code === 'LOCKED')
      now.value = 2_000
      const second = acquireInstanceLock(file, { now: () => now.value, leaseMs: 500, token: 'b' })
      assert.equal(second.token, 'b')
      second.release()
      first.release()
      const third = acquireInstanceLock(file, { now: () => now.value, leaseMs: 500, token: 'c' })
      third.release()
    } finally {
      dir.remove()
    }
  })
})
