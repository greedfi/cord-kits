// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  entrantBlock,
  joinGiveaway,
  partitionEntrants,
  pickWinners,
  planCancel,
  planEnd,
  planReroll,
  scanAnnouncementPages,
} from '../src/giveaway.js'

function openGiveaway(entries) {
  return {
    status: 'open',
    endAt: 1_000,
    entries: [...entries],
    winnerCount: 2,
    winnerIds: [],
    requiredRoleId: 'role',
    minAccountAgeMs: 3_600_000,
    announcePending: false,
    rerolls: [],
    endedAt: null,
  }
}

describe('giveaway announcement scan', () => {
  test('adopts the bot message with the marker and refuses a short history', () => {
    const hit = scanAnnouncementPages([[{
      id: 'm1',
      authorId: 'bot',
      content: 'hello\n\u200bgw:abc123abc123',
      createdTimestamp: 50,
    }]], { id: 'abc123abc123', botId: 'bot', createdAt: 10 })
    assert.equal(hit.found, true)
    assert.equal(hit.messageId, 'm1')
    const ignored = scanAnnouncementPages([[{
      id: 'm2',
      authorId: 'user',
      content: '\u200bgw:abc123abc123',
      createdTimestamp: 50,
    }]], { id: 'abc123abc123', botId: 'bot', createdAt: 10 })
    assert.equal(ignored.found, false)
    assert.equal(ignored.complete, true)
    const full = Array.from({ length: 100 }, (_, index) => ({
      id: `p${index}`,
      authorId: 'bot',
      content: 'other',
      createdTimestamp: 500,
    }))
    const incomplete = scanAnnouncementPages([full, full, full, full, full], {
      id: 'abc123abc123',
      botId: 'bot',
      createdAt: 10,
    })
    assert.equal(incomplete.complete, false)
  })
})

describe('giveaway rules', () => {
  test('CSPRNG selection is unique, in range, and rejects a bad index', () => {
    const seen = []
    const winners = pickWinners(['a', 'b', 'c', 'a'], 2, (max) => {
      seen.push(max)
      return 0
    })
    assert.deepEqual(winners, ['a', 'b'])
    assert.deepEqual(seen, [3, 2])
    assert.throws(() => pickWinners(['a'], 1, () => 1), /out-of-range/)
    assert.deepEqual(pickWinners(['a'], 5, () => 0), ['a'])
  })

  test('eligibility drops leavers, bots, missing roles, young accounts, and duplicates', () => {
    const now = 10_000_000
    const members = new Map([
      ['bot', { id: 'bot', bot: true, roleIds: ['role'], createdAt: 0 }],
      ['young', { id: 'young', bot: false, roleIds: ['role'], createdAt: now }],
      ['norole', { id: 'norole', bot: false, roleIds: [], createdAt: 0 }],
      ['ok', { id: 'ok', bot: false, roleIds: ['role'], createdAt: 0 }],
    ])
    const giveaway = openGiveaway(['gone', 'bot', 'young', 'norole', 'ok'])
    assert.equal(joinGiveaway(giveaway, {
      id: 'ok',
      bot: false,
      roleIds: ['role'],
      createdAt: -10_000_000,
    }, 500).reason, 'duplicate')
    const { accepted, rejected } = partitionEntrants(giveaway.entries, members, {
      requiredRoleId: 'role',
      minAccountAgeMs: 3_600_000,
      now,
    })
    assert.deepEqual(accepted, ['ok'])
    assert.deepEqual(rejected.map((item) => item.reason), ['left', 'bot', 'age', 'role'])
    const ended = planEnd(giveaway, {
      now,
      membersById: members,
      randomInt: () => 0,
    })
    assert.equal(ended.action, 'announce')
    assert.deepEqual(giveaway.winnerIds, ['ok'])
    assert.equal(giveaway.status, 'ended')
    let calls = 0
    const again = planEnd(giveaway, {
      now: 5_000,
      membersById: members,
      randomInt: () => {
        calls += 1
        return 0
      },
    })
    assert.equal(again.action, 'announce')
    assert.equal(calls, 0)
    assert.deepEqual(giveaway.winnerIds, ['ok'])
  })

  test('cancel draws nobody and reroll replays the same interaction', () => {
    const giveaway = openGiveaway(['a', 'b', 'c'])
    giveaway.requiredRoleId = null
    giveaway.minAccountAgeMs = 0
    assert.equal(planCancel(giveaway, 50).ok, true)
    assert.deepEqual(giveaway.winnerIds, [])
    assert.equal(planCancel(giveaway, 60).reason, 'cancelled')
    const ended = openGiveaway(['a', 'b', 'c'])
    ended.requiredRoleId = null
    ended.minAccountAgeMs = 0
    ended.winnerCount = 1
    const members = new Map([
      ['a', { id: 'a', bot: false, roleIds: [], createdAt: 0 }],
      ['b', { id: 'b', bot: false, roleIds: [], createdAt: 0 }],
      ['c', { id: 'c', bot: false, roleIds: [], createdAt: 0 }],
    ])
    planEnd(ended, { now: 1_000, membersById: members, randomInt: () => 0 })
    assert.deepEqual(ended.winnerIds, ['a'])
    const reroll = planReroll(ended, { interactionId: 'i1', now: 2_000, randomInt: () => 0 })
    assert.deepEqual(reroll.winnerIds, ['b'])
    let calls = 0
    const replay = planReroll(ended, {
      interactionId: 'i1',
      now: 3_000,
      randomInt: () => {
        calls += 1
        return 0
      },
    })
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.winnerIds, ['b'])
    assert.equal(calls, 0)
    assert.equal(entrantBlock(null, { requiredRoleId: null, minAccountAgeMs: 0, now: 0 }), 'left')
  })
})
