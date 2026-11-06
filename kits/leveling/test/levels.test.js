// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decideAward, leaderboard, levelForXp, messageGate, xpToReach } from '../src/levels.js'

describe('level thresholds', () => {
  test('uses the closed form at the boundaries', () => {
    assert.equal(xpToReach(0), 0)
    assert.equal(xpToReach(1), 100)
    assert.equal(xpToReach(2), 300)
    assert.equal(xpToReach(3), 600)
    assert.equal(xpToReach(100), 505000)
    assert.equal(levelForXp(0), 0)
    assert.equal(levelForXp(99), 0)
    assert.equal(levelForXp(100), 1)
    assert.equal(levelForXp(299), 1)
    assert.equal(levelForXp(300), 2)
    assert.equal(levelForXp(599), 2)
    assert.equal(levelForXp(600), 3)
    assert.equal(levelForXp(505000), 100)
    assert.equal(levelForXp(504999), 99)
    const capped = decideAward({
      xp: xpToReach(200),
      lastAwardAt: 0,
      now: 10,
      cooldownMs: 0,
      amount: 50,
    })
    assert.equal(capped.reason, 'cap')
    assert.equal(capped.xp, xpToReach(200))
  })

  test('cooldown blocks a second award at the same timestamp', () => {
    const first = decideAward({ xp: 0, lastAwardAt: 0, now: 1_000, cooldownMs: 60_000, amount: 15 })
    assert.equal(first.award, true)
    assert.equal(first.xp, 15)
    const second = decideAward({
      xp: first.xp, lastAwardAt: first.lastAwardAt, now: 1_000, cooldownMs: 60_000, amount: 15,
    })
    assert.equal(second.reason, 'cooldown')
    const later = decideAward({
      xp: first.xp, lastAwardAt: first.lastAwardAt, now: 61_000, cooldownMs: 60_000, amount: 15,
    })
    assert.equal(later.xp, 30)
  })

  test('does not read message text and orders ties by user id', () => {
    const message = {
      guild: { id: '1' },
      author: { id: '9', bot: false },
      channelId: '2',
      member: { roleIds: [] },
      get content() { throw new Error('content read') },
    }
    assert.equal(messageGate(message, { excludedChannelIds: [], excludedRoleIds: [] }), null)
    assert.equal(messageGate({
      guild: { id: '1' },
      author: { id: '9', bot: false },
      channelId: '9',
      member: { roleIds: [] },
    }, { excludedChannelIds: ['9'], excludedRoleIds: [] }), 'channel')
    assert.equal(messageGate({ author: { bot: true }, guild: {} }, {}), 'bot')
    const rows = leaderboard({
      b: { xp: 10 },
      a: { xp: 10 },
      c: { xp: 5 },
    })
    assert.deepEqual(rows.map((row) => row.userId), ['a', 'b', 'c'])
  })
})
