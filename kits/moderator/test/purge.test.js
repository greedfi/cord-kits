import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PURGE_MAX_AGE_MS, selectPurgeMessages } from '../src/purge.js'

const now = 1_700_000_000_000

describe('purge selection', () => {
  test('keeps the newest matching messages under 14 days', () => {
    const messages = [
      { id: 'old', authorId: 'a', createdAt: now - PURGE_MAX_AGE_MS - 1 },
      { id: 'b', authorId: 'b', createdAt: now - 3000 },
      { id: 'a2', authorId: 'a', createdAt: now - 2000 },
      { id: 'a1', authorId: 'a', createdAt: now - 1000 },
    ]
    const all = selectPurgeMessages(messages, { now, limit: 2 })
    assert.deepEqual(all.map((message) => message.id), ['a1', 'a2'])
    const onlyA = selectPurgeMessages(messages, { userId: 'a', now, limit: 10 })
    assert.deepEqual(onlyA.map((message) => message.id), ['a1', 'a2'])
    const none = selectPurgeMessages(
      [{ id: 'old', authorId: 'a', createdAt: now - PURGE_MAX_AGE_MS }],
      { now, limit: 5 },
    )
    assert.deepEqual(none, [])
  })
})
