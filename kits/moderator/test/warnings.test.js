import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { addWarning, createWarningStore } from '../src/warnings.js'
import { tempDir } from './helpers.js'

describe('warnings', () => {
  test('counts are per user and per guild, and reasons are truncated', () => {
    let data = {}
    const first = addWarning(data, {
      guildId: 'g',
      userId: 'u',
      moderatorId: 'm',
      reason: 'spam',
      at: 't1',
    })
    assert.equal(first.count, 1)
    assert.equal(first.entry.id, 1)
    const second = addWarning(first.data, {
      guildId: 'g',
      userId: 'u',
      moderatorId: 'm',
      reason: 'spam again',
      at: 't2',
    })
    assert.equal(second.count, 2)
    assert.equal(second.entry.id, 2)
    const otherGuild = addWarning(second.data, {
      guildId: 'g2',
      userId: 'u',
      moderatorId: 'm',
      reason: 'x',
      at: 't3',
    })
    assert.equal(otherGuild.count, 1)
    assert.equal(second.data.g.length, 2)
    const long = addWarning(data, {
      guildId: 'g',
      userId: 'u',
      moderatorId: 'm',
      reason: 'x'.repeat(600),
      at: 't',
    })
    assert.equal(long.entry.reason.length, 512)
    assert.throws(() => addWarning(data, {
      guildId: 'g',
      userId: 'u',
      moderatorId: 'm',
      reason: '   ',
    }), /reason/)
  })

  test('the store round-trips through disk', () => {
    const dir = tempDir()
    try {
      const filePath = dir.path('warnings.json')
      const store = createWarningStore(filePath)
      store.add({ guildId: 'g', userId: 'u', moderatorId: 'm', reason: 'spam', at: 't' })
      const reloaded = createWarningStore(filePath)
      assert.equal(reloaded.list('g', 'u').length, 1)
      assert.equal(reloaded.list('g', 'u')[0].reason, 'spam')
      assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).g[0].id, 1)
    } finally {
      dir.remove()
    }
  })
})
