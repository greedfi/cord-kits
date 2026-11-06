// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { handleAutomod } from '../src/automod.js'
import { createRateLimiter } from '../src/limits.js'
import { defaultGuildSettings } from '../src/settings.js'

function settings() {
  const value = defaultGuildSettings()
  value.wordFilter = { enabled: true, match: 'word', words: ['spam'] }
  return value
}

function message(partial = {}) {
  const deleted = []
  return {
    deleted,
    guild: { id: '111111111111111111' },
    author: { id: '444444444444444444', tag: 'User#0001', bot: false },
    channel: { id: '555555555555555555' },
    content: 'this is spam',
    member: partial.member === undefined ? { permissions: { has: () => false }, roleIds: [] } : partial.member,
    deletable: partial.deletable,
    async delete(reason) {
      deleted.push(reason)
    },
  }
}

describe('automod', () => {
  test('deletes a matching message with an audit reason', async () => {
    const target = message()
    const result = await handleAutomod(target, { settings: settings() })
    assert.equal(result.action, 'deleted')
    assert.deepEqual(target.deleted, ['Filter (word)'])
  })

  test('does not delete staff, exempt roles, bots, or an unresolved member', async () => {
    const staff = message({
      member: { permissions: { has: (bit) => bit === PermissionFlagsBits.ModerateMembers }, roleIds: [] },
    })
    assert.equal((await handleAutomod(staff, { settings: settings() })).action, 'exempt')
    assert.equal(staff.deleted.length, 0)

    const admin = message({
      member: { permissions: { has: (bit) => bit === PermissionFlagsBits.Administrator }, roleIds: [] },
    })
    assert.equal((await handleAutomod(admin, { settings: settings() })).exemption, 'administrator')

    const configured = settings()
    configured.exemptRoleIds = ['999999999999999999']
    const role = message({
      member: { permissions: { has: () => false }, roleIds: ['999999999999999999'] },
    })
    assert.equal((await handleAutomod(role, { settings: configured })).exemption, 'role')

    const unresolved = message({ member: null })
    const fetched = []
    const skipped = await handleAutomod(unresolved, {
      settings: settings(),
      fetchMember: async (id) => {
        fetched.push(id)
        return null
      },
    })
    assert.equal(skipped.exemption, 'unresolved')
    assert.deepEqual(fetched, ['444444444444444444'])
    assert.equal(unresolved.deleted.length, 0)

    const bot = message()
    bot.author = { ...bot.author, bot: true }
    assert.equal((await handleAutomod(bot, { settings: settings() })).action, 'ignore')
  })

  test('stops deleting once the guild window is full and logs once', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 10_000, now: () => 5_000 })
    const logs = []
    const first = message()
    const second = message()
    const third = message()
    const fourth = message()
    const opts = { settings: settings(), limiter, log: async (text) => logs.push(text) }
    assert.equal((await handleAutomod(first, opts)).action, 'deleted')
    assert.equal((await handleAutomod(second, opts)).action, 'deleted')
    assert.equal((await handleAutomod(third, opts)).action, 'rate_limited')
    assert.equal((await handleAutomod(fourth, opts)).action, 'rate_limited')
    assert.equal(third.deleted.length, 0)
    const limited = logs.filter((text) => text.includes('rate limit'))
    assert.equal(limited.length, 1)
  })
})
