// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { readFileSync, statSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Events, PermissionFlagsBits } from 'discord.js'
import { canViewTicket } from '../src/privacy.js'
import { createRuntime } from '../src/runtime.js'
import { createJsonStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const GUILD = '111111111111111111'
const OPENER = '222222222222222222'
const STAFF = '333333333333333333'
const BOT = '444444444444444444'
const STRANGER = '555555555555555555'
const STAFF_USER = '888888888888888888'

function member(id, roleIds = [], manage = false) {
  return {
    id,
    roleIds,
    permissions: {
      has(bit) {
        if (manage && bit === PermissionFlagsBits.ManageChannels) return true
        return false
      },
    },
  }
}

describe('ticket runtime', () => {
  test('private channels, one active ticket, confirmed close, and staff-only transcripts', async () => {
    const dir = tempDir()
    const created = []
    const deleted = []
    let failHistory = false
    const store = createJsonStore(dir.path('tickets.json'))
    const guild = {
      id: GUILD,
      members: { me: { id: BOT, permissions: { has: () => true } } },
      channels: {
        async create(payload) {
          const channel = {
            id: `channel-${created.length + 1}`,
            guildId: GUILD,
            payload,
            async send() {},
            async delete(reason) { deleted.push(reason) },
          }
          created.push(channel)
          return channel
        },
        cache: new Map(),
        async fetch(id) { return created.find((channel) => channel.id === id) },
      },
    }
    const config = {
      dataRoot: dir.dir,
      get: () => ({
        guilds: {
          [GUILD]: { staffRoleId: STAFF, categoryId: null, oneActive: true, transcripts: true },
        },
      }),
      onReload() { return () => {} },
    }
    const runtime = createRuntime({
      configStore: config,
      store,
      now: () => 5_000,
      fetchGuild: async () => guild,
      readMessages: async () => {
        if (failHistory) throw new Error('history failed')
        return [{ authorId: OPENER, content: 'hello @everyone', at: 1_000 }]
      },
    })
    const replies = []
    function interact(partial) {
      return {
        commandName: 'ticket',
        guild: { id: GUILD },
        user: { id: partial.userId ?? OPENER },
        member: partial.member ?? member(partial.userId ?? OPENER),
        channelId: partial.channelId,
        customId: partial.customId,
        deferred: false,
        replied: false,
        inGuild: () => true,
        isChatInputCommand: () => !partial.customId,
        isButton: () => Boolean(partial.customId),
        options: {
          getSubcommand: () => partial.sub,
          getString: () => partial.id ?? null,
          getChannel: () => partial.channel,
        },
        async reply(payload) { this.replied = true; replies.push(payload.content ?? payload) },
        async deferReply() { this.deferred = true },
        async editReply(payload) { replies.push(typeof payload === 'string' ? payload : payload.content) },
        async followUp(payload) { replies.push(payload.content) },
      }
    }
    try {
      await Promise.all([
        runtime.handleInteraction(interact({ sub: 'open', reason: 'help' })),
        runtime.handleInteraction(interact({ sub: 'open', reason: 'again' })),
      ])
      assert.equal(created.length, 1)
      const overwrites = created[0].payload.permissionOverwrites
      assert.equal(canViewTicket({
        userId: STRANGER, roleIds: [], openerId: OPENER, staffRoleId: STAFF, botId: BOT,
      }).view, false)
      assert.ok(overwrites.find((entry) => entry.id === GUILD).deny.includes(PermissionFlagsBits.ViewChannel))
      const id = created[0].payload.name.slice('ticket-'.length)
      await runtime.handleInteraction(interact({
        customId: `ticket:close:${id}`,
        userId: STRANGER,
        member: member(STRANGER),
      }))
      assert.match(replies.at(-1), /Only the person who opened/)
      assert.equal(deleted.length, 0)
      await runtime.handleInteraction(interact({ customId: `ticket:close:${id}` }))
      await runtime.handleInteraction(interact({ customId: `ticket:yes:${id}` }))
      assert.match(replies.at(-1), /staff member/)
      assert.equal(deleted.length, 0)
      failHistory = true
      await runtime.handleInteraction(interact({
        customId: `ticket:yes:${id}`,
        userId: STAFF_USER,
        member: member(STAFF_USER, [STAFF]),
      }))
      assert.match(replies.at(-1), /Command failed/)
      assert.equal(deleted.length, 0)
      failHistory = false
      await runtime.handleInteraction(interact({
        customId: `ticket:yes:${id}`,
        userId: STAFF_USER,
        member: member(STAFF_USER, [STAFF]),
      }))
      assert.equal(deleted.length, 1)
      const file = `${dir.dir}/transcripts/${GUILD}/${id}.txt`
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.match(readFileSync(file, 'utf8'), /hello/)
      await runtime.handleInteraction(interact({
        sub: 'transcript', id, userId: STRANGER, member: member(STRANGER),
      }))
      assert.match(replies.at(-1), /Only the configured staff role/)
      await runtime.handleInteraction(interact({
        sub: 'transcript', id, userId: STAFF_USER, member: member(STAFF_USER, [STAFF]),
      }))
      assert.match(replies.at(-1), /hello/)
      const restarted = createRuntime({
        configStore: config,
        store: createJsonStore(dir.path('tickets.json')),
        now: () => 5_000,
        fetchGuild: async () => guild,
      })
      const client = {
        handlers: {},
        on(event, fn) { this.handlers[event] = fn },
        once(event, fn) { this.handlers[event] = fn },
      }
      restarted.bind(client)
      assert.equal(typeof client.handlers[Events.InteractionCreate], 'function')
      const saved = await store.read()
      assert.equal(saved.guilds[GUILD][id].status, 'closed')
      await restarted.handleInteraction(interact({ sub: 'open' }))
      assert.equal(created.length, 2)
    } finally {
      dir.remove()
    }
  })
})
