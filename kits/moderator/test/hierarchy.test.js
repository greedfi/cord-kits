import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MODERATION_BLOCK_REASON, moderationBlock } from '../src/hierarchy.js'

const base = {
  actorId: 'mod',
  targetId: 'user',
  ownerId: 'owner',
  botId: 'bot',
  actorHighest: 5,
  targetHighest: 2,
  botHighest: 10,
}

describe('hierarchy', () => {
  test('blocks self, the bot, the owner, and equal-or-higher roles', () => {
    assert.equal(moderationBlock(base), null)
    assert.equal(moderationBlock({ ...base, targetId: 'mod' }), 'self')
    assert.equal(moderationBlock({ ...base, targetId: 'bot' }), 'bot')
    assert.equal(moderationBlock({ ...base, targetId: 'owner' }), 'owner')
    assert.equal(moderationBlock({ ...base, targetHighest: 10 }), 'bot_hierarchy')
    assert.equal(moderationBlock({ ...base, targetHighest: 5 }), 'actor_hierarchy')
    assert.equal(moderationBlock({ ...base, actorId: 'owner', targetHighest: 9 }), null)
    assert.equal(moderationBlock({ ...base, actorId: 'owner', targetHighest: 10 }), 'bot_hierarchy')
    assert.match(MODERATION_BLOCK_REASON.owner, /owner/)
  })
})
