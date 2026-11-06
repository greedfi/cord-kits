// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js'
import { createRateLimiter } from '../src/limits.js'
import { INTENTS, createRuntime } from '../src/runtime.js'
import { createJsonStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const GUILD = '111111111111111111'
const OTHER = '222222222222222222'
const USER = '333333333333333333'
const ROLE = '444444444444444444'

function message(guildId, userId, extra = {}) {
  return {
    guild: { id: guildId },
    author: { id: userId, bot: false },
    channelId: '555555555555555555',
    member: { roleIds: extra.roleIds ?? [] },
    get content() { throw new Error('content read') },
    ...extra,
  }
}

describe('leveling runtime', () => {
  test('concurrent awards, guild isolation, rewards, and restart recovery', async () => {
    assert.ok(INTENTS.includes(GatewayIntentBits.GuildMessages))
    assert.equal(INTENTS.includes(GatewayIntentBits.MessageContent), false)
    const dir = tempDir()
    const added = []
    let failGrant = true
    const role = {
      id: ROLE,
      position: 1,
      managed: false,
      permissions: { has: () => false },
    }
    const guild = {
      id: GUILD,
      members: {
        me: { permissions: { has: (bit) => bit === PermissionFlagsBits.ManageRoles }, roles: { highest: { position: 10 } } },
        async fetch() { return { roles: { async add(id) { if (failGrant) throw new Error('no'); added.push(id) } } } },
      },
      roles: { async fetch(id) { return id === ROLE ? role : null } },
    }
    const store = createJsonStore(dir.path('levels.json'))
    const config = {
      get: () => ({
        xpPerMessage: 100,
        cooldownSeconds: 0,
        guilds: {
          [GUILD]: { rewards: [{ level: 1, roleId: ROLE }] },
          [OTHER]: { xpPerMessage: 5, cooldownSeconds: 0, rewards: [] },
        },
      }),
    }
    const runtime = createRuntime({
      configStore: config,
      store,
      now: () => 10_000,
      fetchGuild: async () => guild,
      burst: createRateLimiter({ limit: 100, windowMs: 10_000, now: () => 10_000 }),
    })
    try {
      await Promise.all(Array.from({ length: 40 }, () => runtime.onMessage(message(GUILD, USER))))
      const data = await store.read()
      assert.equal(data.guilds[GUILD].users[USER].xp, 4000)
      assert.deepEqual(data.guilds[GUILD].pending[USER], [ROLE])
      assert.equal(added.length, 0)
      failGrant = false
      const restarted = createRuntime({
        configStore: config,
        store: createJsonStore(dir.path('levels.json')),
        now: () => 10_000,
        fetchGuild: async () => guild,
      })
      await restarted.reconcile()
      const after = await createJsonStore(dir.path('levels.json')).read()
      assert.equal(after.guilds[GUILD].pending[USER], undefined)
      assert.deepEqual(added, [ROLE])
      await restarted.reconcile()
      assert.deepEqual(added, [ROLE])
      role.permissions.has = (bit) => bit === PermissionFlagsBits.Administrator
      await restarted.onMessage(message(GUILD, '999999999999999999'))
      assert.deepEqual(added, [ROLE])
      const skipped = await createJsonStore(dir.path('levels.json')).read()
      assert.deepEqual(skipped.guilds[GUILD].skipped['999999999999999999'], [ROLE])
      const other = await restarted.onMessage(message(OTHER, USER))
      assert.equal(other.award, true)
      const separated = await createJsonStore(dir.path('levels.json')).read()
      assert.equal(separated.guilds[OTHER].users[USER].xp, 5)
      assert.equal(separated.guilds[GUILD].users[USER].xp, 4000)
      const client = { handlers: {}, on(event, fn) { this.handlers[event] = fn }, once(event, fn) { this.handlers[event] = fn } }
      runtime.bind(client)
      assert.equal(typeof client.handlers[Events.MessageCreate], 'function')
      assert.equal(typeof client.handlers[Events.ClientReady], 'function')
    } finally {
      dir.remove()
    }
  })
})
