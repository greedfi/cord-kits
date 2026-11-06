// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Events, PermissionFlagsBits } from 'discord.js'
import { createRuntime } from '../src/runtime.js'
import { createJsonStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const GUILD = '111111111111111111'
const OTHER = '222222222222222222'
const CHANNEL = '333333333333333333'

function xml(ids) {
  const items = ids.map((id) => `<item><title>Hello @everyone ${id}</title><link>https://example.com/${id}</link><guid>${id}</guid><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>`).join('')
  return `<rss><channel>${items}</channel></rss>`
}

describe('feed runtime', () => {
  test('seeds without posting, dedupes across a restart, and refuses a bad destination', async () => {
    const dir = tempDir()
    const sent = []
    let body = xml(['a'])
    let fetches = 0
    let time = 1_000
    const history = []
    const channel = {
      id: CHANNEL,
      guildId: GUILD,
      async send(payload) { sent.push(payload) },
      messages: { async fetch() { return { values() { return history.slice() } } } },
    }
    const guild = {
      id: GUILD,
      members: { me: { id: '999999999999999999' } },
      channels: { cache: new Map([[CHANNEL, channel]]), async fetch() { return channel } },
    }
    const store = createJsonStore(dir.path('feeds.json'))
    const config = {
      pollIntervalSeconds: 300,
      guilds: {
        [GUILD]: {
          destinations: [CHANNEL],
          feeds: [{ id: 'news', url: 'https://example.com/feed.xml', channelId: CHANNEL }],
        },
        [OTHER]: {
          destinations: [],
          feeds: [{ id: 'news', url: 'https://secret.example/feed.xml', channelId: CHANNEL }],
        },
      },
    }
    const runtime = createRuntime({
      configStore: { get: () => config, onReload() { return () => {} } },
      store,
      now: () => time,
      fetchGuild: async (id) => (id === GUILD ? guild : { id, channels: { cache: new Map(), async fetch() { throw new Error('no') } } }),
      fetchFeed: async (url) => {
        fetches += 1
        if (url.includes('secret')) throw new Error('should not fetch a disallowed destination')
        return body
      },
    })
    try {
      await runtime.tick()
      assert.equal(sent.length, 0)
      assert.equal(fetches, 1)
      const seeded = await store.read()
      assert.deepEqual(seeded.feeds[`${GUILD}:news`].seen, ['a'])
      await runtime.tick()
      assert.equal(fetches, 1)
      time += 300_000
      body = xml(['a', 'b'])
      await runtime.tick()
      assert.equal(sent.length, 1)
      assert.match(sent[0].content, /@\u200beveryone/)
      assert.deepEqual(sent[0].allowedMentions, { parse: [] })
      assert.equal(fetches, 2)
      await runtime.tick()
      assert.equal(fetches, 2)
      time += 300_000
      const restarted = createRuntime({
        configStore: { get: () => config, onReload() { return () => {} } },
        store: createJsonStore(dir.path('feeds.json')),
        now: () => time,
        fetchGuild: async () => guild,
        fetchFeed: async () => {
          fetches += 1
          return body
        },
      })
      await restarted.tick()
      assert.equal(sent.length, 1)
      const client = { handlers: {}, on(event, fn) { this.handlers[event] = fn }, once(event, fn) { this.handlers[event] = fn } }
      restarted.bind(client)
      assert.equal(typeof client.handlers[Events.InteractionCreate], 'function')
      restarted.shutdown()
      const saved = await store.read()
      assert.ok(saved.feeds[`${OTHER}:news`].lastError.includes('allowlist'))
    } finally {
      runtime.shutdown()
      dir.remove()
    }
  })

  test('status hides the feed URL and checks Manage Guild', async () => {
    const dir = tempDir()
    const store = createJsonStore(dir.path('feeds.json'))
    const config = {
      pollIntervalSeconds: 300,
      guilds: {
        [GUILD]: {
          destinations: [CHANNEL],
          feeds: [{ id: 'news', url: 'https://user:secret@example.com/feed.xml?token=1', channelId: CHANNEL }],
        },
      },
    }
    const runtime = createRuntime({
      configStore: { get: () => config, onReload() { return () => {} } },
      store,
      fetchGuild: async () => ({ id: GUILD, channels: { cache: new Map() } }),
    })
    const replies = []
    const interaction = {
      commandName: 'feed',
      guild: { id: GUILD },
      inGuild: () => true,
      isChatInputCommand: () => true,
      options: { getSubcommand: () => 'status' },
      member: { permissions: { has: () => false } },
      async reply(payload) { replies.push(payload.content) },
      async followUp(payload) { replies.push(payload.content) },
    }
    try {
      await runtime.handleInteraction(interaction)
      assert.match(replies[0], /Manage Guild/)
      replies.length = 0
      interaction.member.permissions.has = (bit) => bit === PermissionFlagsBits.ManageGuild
      await runtime.handleInteraction(interaction)
      assert.match(replies[0], /news:/)
      assert.doesNotMatch(replies[0], /example.com|secret|token/)
    } finally {
      dir.remove()
    }
  })

  test('a crash after a feed send does not post that entry again', async () => {
    const dir = tempDir()
    const sent = []
    const history = []
    const channel = {
      id: CHANNEL,
      guildId: GUILD,
      async send(payload) { sent.push(payload) },
      messages: { async fetch() { return { values() { return history.slice() } } } },
    }
    const guild = {
      id: GUILD,
      members: { me: { id: '999999999999999999' } },
      channels: { cache: new Map([[CHANNEL, channel]]), async fetch() { return channel } },
    }
    const real = createJsonStore(dir.path('feeds.json'))
    let crash = false
    const store = {
      read: () => real.read(),
      update: (mutator) => real.update(async (data) => {
        const result = await mutator(data)
        if (crash) {
          const state = data.feeds?.[`${GUILD}:news`]
          if (Array.isArray(state?.seen) && state.seen.includes('b')) {
            crash = false
            throw new Error('crash before persist')
          }
        }
        return result
      }),
    }
    let time = 1_000
    let ids = ['a']
    const body = () => xml(ids)
    const runtime = createRuntime({
      configStore: {
        get: () => ({
          pollIntervalSeconds: 300,
          guilds: {
            [GUILD]: {
              destinations: [CHANNEL],
              feeds: [{ id: 'news', url: 'https://example.com/feed.xml', channelId: CHANNEL }],
            },
          },
        }),
        onReload() { return () => {} },
      },
      store,
      now: () => time,
      fetchGuild: async () => guild,
      fetchFeed: async () => body(),
    })
    try {
      await runtime.tick()
      time += 300_000
      ids = ['a', 'b']
      crash = true
      await runtime.tick()
      assert.equal(sent.length, 1)
      history.push({
        id: 'posted-1',
        content: sent[0].content,
        author: { id: '999999999999999999' },
      })
      time += 300_000
      await runtime.tick()
      assert.equal(sent.length, 1)
      const saved = await createJsonStore(dir.path('feeds.json')).read()
      assert.ok(saved.feeds[`${GUILD}:news`].seen.includes('b'))
    } finally {
      runtime.shutdown()
      dir.remove()
    }
  })

  test('a first feed post is not blocked by a busy channel, and an attempted post fails closed', async () => {
    const dir = tempDir()
    const sent = []
    const history = Array.from({ length: 600 }, (_, index) => ({
      id: `busy-${index}`,
      content: 'unrelated',
      author: { id: '999999999999999999' },
    }))
    let failHistory = false
    const channel = {
      id: CHANNEL,
      guildId: GUILD,
      async send(payload) { sent.push(payload) },
      messages: {
        async fetch() {
          if (failHistory) throw new Error('history down')
          return { values() { return history.slice() } }
        },
      },
    }
    const guild = {
      id: GUILD,
      members: { me: { id: '999999999999999999' } },
      channels: { cache: new Map([[CHANNEL, channel]]), async fetch() { return channel } },
    }
    const store = createJsonStore(dir.path('feeds.json'))
    let time = 1_000
    let ids = ['a']
    const runtime = createRuntime({
      configStore: {
        get: () => ({
          pollIntervalSeconds: 300,
          guilds: {
            [GUILD]: {
              destinations: [CHANNEL],
              feeds: [{ id: 'news', url: 'https://example.com/feed.xml', channelId: CHANNEL }],
            },
          },
        }),
        onReload() { return () => {} },
      },
      store,
      now: () => time,
      fetchGuild: async () => guild,
      fetchFeed: async () => xml(ids),
    })
    try {
      await runtime.tick()
      time += 300_000
      ids = ['a', 'b']
      await runtime.tick()
      assert.equal(sent.length, 1)
      assert.equal(sent[0].enforceNonce, true)
      assert.match(sent[0].nonce, /^f[0-9a-f]{16}$/)
      const key = `${GUILD}:news`
      const posted = await store.read()
      assert.ok(posted.feeds[key].seen.includes('b'))
      await store.update((data) => {
        data.feeds[key].seen = data.feeds[key].seen.filter((id) => id !== 'b')
        data.feeds[key].inflight = ['b']
        data.feeds[key].nextAttemptAt = 0
      })
      failHistory = true
      time += 300_000
      await runtime.tick()
      assert.equal(sent.length, 1)
      const saved = await store.read()
      assert.equal(saved.feeds[key].seen.includes('b'), false)
      assert.deepEqual(saved.feeds[key].inflight, ['b'])
    } finally {
      runtime.shutdown()
      dir.remove()
    }
  })
})
