// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js'
import { createRuntime } from '../src/runtime.js'
import { createJsonStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const GUILD = '111111111111111111'
const OTHER = '222222222222222222'
const CHANNEL = '333333333333333333'
const MANAGER_ROLE = '444444444444444444'
const USER = '555555555555555555'
const OTHER_USER = '666666666666666666'

function config(extra = {}) {
  return {
    get() {
      return {
        schedulerIntervalSeconds: 30,
        maxWinners: 2,
        maxDurationMinutes: 60,
        minAccountAgeHours: 0,
        guilds: {
          [GUILD]: { managerRoleId: MANAGER_ROLE, ...extra },
        },
      }
    },
    onReload() {
      return () => {}
    },
    close() {},
  }
}

function member(id, { bot = false, roleIds = [], createdAt = 0 } = {}) {
  return {
    id,
    user: { id, bot, createdTimestamp: createdAt },
    roles: { cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])) },
    roleIds,
  }
}

function harness({ failSend = 0, failFetch = false, canSend = true } = {}) {
  const dir = tempDir()
  const sent = []
  const edits = []
  const history = []
  let sendFailures = failSend
  const channel = {
    id: CHANNEL,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor() {
      return { has: () => canSend }
    },
    async send(payload) {
      if (sendFailures > 0) {
        sendFailures -= 1
        throw new Error('send failed')
      }
      const message = { id: `message-${sent.length + 1}` }
      sent.push({ message, payload })
      return message
    },
    messages: {
      async fetch() {
        return { values() { return history.slice() } }
      },
      async edit(id, payload) {
        edits.push({ id, payload })
        return { id }
      },
    },
  }
  const people = new Map([
    [USER, member(USER)],
    [OTHER_USER, member(OTHER_USER)],
  ])
  const guild = {
    id: GUILD,
    members: {
      me: { id: '999999999999999999' },
      async fetch(id) {
        if (failFetch) {
          const error = new Error('down')
          error.code = 500
          throw error
        }
        const found = people.get(id)
        if (!found) {
          const error = new Error('unknown')
          error.code = 10007
          throw error
        }
        return found
      },
    },
    channels: {
      cache: new Map([[CHANNEL, channel]]),
      async fetch() {
        return channel
      },
    },
  }
  const store = createJsonStore(dir.path('giveaways.json'))
  let draws = 0
  const runtime = createRuntime({
    configStore: config(),
    store,
    now: () => 1_000_000,
    randomInt: (max) => {
      draws += 1
      return 0 % max
    },
    fetchGuild: async () => guild,
  })
  return {
    dir,
    sent,
    edits,
    history,
    store,
    runtime,
    channel,
    guild,
    people,
    draws: () => draws,
    setFailFetch(value) {
      failFetch = value
    },
  }
}

function command(partial) {
  const replies = []
  const interaction = {
    id: partial.interactionId ?? 'interaction-1',
    commandName: 'giveaway',
    guild: { id: partial.guildId ?? GUILD, members: { me: { id: '999999999999999999' } } },
    user: partial.user ?? { id: USER, bot: false, createdTimestamp: 0 },
    member: partial.member ?? {
      permissions: { has: (bit) => bit === PermissionFlagsBits.ManageGuild },
      roleIds: [],
    },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => true,
    isButton: () => false,
    options: {
      getSubcommand: () => partial.sub,
      getString: (name) => (name === 'id' ? partial.giveawayId ?? partial.id ?? null : partial[name] ?? null),
      getInteger: (name) => partial[name] ?? null,
      getChannel: () => partial.channel,
      getRole: () => partial.role ?? null,
    },
    async reply(payload) {
      this.replied = true
      replies.push(payload)
    },
    async deferReply() {
      this.deferred = true
    },
    async editReply(payload) {
      replies.push(typeof payload === 'string' ? { content: payload } : payload)
    },
    async followUp(payload) {
      replies.push(payload)
    },
  }
  return { interaction, replies }
}

describe('giveaway runtime', () => {
  test('refuses a manager command without Manage Guild or the manager role', async () => {
    const box = harness()
    try {
      const { interaction, replies } = command({
        sub: 'create',
        member: { permissions: { has: () => false }, roleIds: [] },
        channel: box.channel,
        prize: 'hat',
        minutes: 10,
        winners: 1,
      })
      await box.runtime.handleInteraction(interaction)
      assert.match(replies[0].content, /Manage Guild/)
      assert.equal(box.sent.length, 0)
    } finally {
      box.dir.remove()
    }
  })

  test('posts once, rejects a duplicate entry, and ends without drawing twice', async () => {
    const box = harness()
    try {
      const created = command({
        sub: 'create',
        channel: box.channel,
        prize: 'hat @everyone',
        minutes: 10,
        winners: 1,
      })
      await box.runtime.handleInteraction(created.interaction)
      assert.equal(box.sent.length, 1)
      assert.match(box.sent[0].payload.content, /hat @\u200beveryone/)
      assert.deepEqual(box.sent[0].payload.allowedMentions.parse, [])
      const row = box.sent[0].payload.components[0].toJSON()
      const id = row.components[0].custom_id.slice('gw:join:'.length)
      const join = command({
        sub: 'ignored',
        user: { id: USER, bot: false, createdTimestamp: 0 },
      })
      join.interaction.isChatInputCommand = () => false
      join.interaction.isButton = () => true
      join.interaction.customId = `gw:join:${id}`
      await box.runtime.handleInteraction(join.interaction)
      await box.runtime.handleInteraction(join.interaction)
      assert.match(join.replies.at(-1).content, /already entered/)
      const other = command({ user: { id: OTHER_USER, bot: false, createdTimestamp: 0 } })
      other.interaction.isChatInputCommand = () => false
      other.interaction.isButton = () => true
      other.interaction.customId = `gw:join:${id}`
      await box.runtime.handleInteraction(other.interaction)
      const foreign = command({ guildId: OTHER, user: { id: USER, bot: false, createdTimestamp: 0 } })
      foreign.interaction.isChatInputCommand = () => false
      foreign.interaction.isButton = () => true
      foreign.interaction.customId = `gw:join:${id}`
      await box.runtime.handleInteraction(foreign.interaction)
      assert.match(foreign.replies[0].content, /no longer active/)
      const before = box.draws()
      const ended = command({ sub: 'end', id })
      await box.runtime.handleInteraction(ended.interaction)
      assert.equal(box.draws(), before + 1)
      assert.match(ended.replies.at(-1).content, new RegExp(`<@${USER}>`))
      await box.runtime.tick()
      assert.equal(box.draws(), before + 1)
      const data = await box.store.read()
      assert.equal(data.guilds[GUILD][id].entries.length, 2)
      assert.equal(data.guilds[OTHER], undefined)
      const restarted = createRuntime({
        configStore: config(),
        store: createJsonStore(box.dir.path('giveaways.json')),
        now: () => 1_000_000,
        randomInt: () => {
          throw new Error('redraw')
        },
        fetchGuild: async () => box.guild,
      })
      await restarted.tick()
      restarted.shutdown()
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('a failed member lookup does not draw, and a failed post does not draw twice', async () => {
    const box = harness()
    try {
      const created = command({
        sub: 'create',
        channel: box.channel,
        prize: 'mug',
        minutes: 5,
        winners: 1,
      })
      await box.runtime.handleInteraction(created.interaction)
      const id = box.sent[0].payload.components[0].toJSON().components[0].custom_id.slice('gw:join:'.length)
      const join = command({ user: { id: USER, bot: false, createdTimestamp: 0 } })
      join.interaction.isChatInputCommand = () => false
      join.interaction.isButton = () => true
      join.interaction.customId = `gw:join:${id}`
      await box.runtime.handleInteraction(join.interaction)
      box.setFailFetch(true)
      const blocked = command({ sub: 'end', id })
      await box.runtime.handleInteraction(blocked.interaction)
      assert.match(blocked.replies.at(-1).content, /not made/)
      assert.equal(box.draws(), 0)
      const mid = await box.store.read()
      assert.equal(mid.guilds[GUILD][id].status, 'open')
      box.setFailFetch(false)
      const ended = command({ sub: 'end', id })
      await box.runtime.handleInteraction(ended.interaction)
      assert.equal(box.draws(), 1)
      const flaky = harness({ failSend: 1 })
      const first = command({
        sub: 'create',
        channel: flaky.channel,
        prize: 'sticker',
        minutes: 5,
        winners: 1,
      })
      await flaky.runtime.handleInteraction(first.interaction)
      assert.match(first.replies.at(-1).content, /will be retried/)
      assert.equal(flaky.sent.length, 0)
      await flaky.runtime.tick()
      assert.equal(flaky.sent.length, 1)
      const saved = await flaky.store.read()
      const savedId = Object.keys(saved.guilds[GUILD])[0]
      assert.equal(saved.guilds[GUILD][savedId].announcePending, false)
      assert.equal(saved.guilds[GUILD][savedId].messageId, 'message-1')
      flaky.runtime.shutdown()
      flaky.dir.remove()
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('cancel draws nobody and a reroll interaction replays', async () => {
    const box = harness()
    try {
      const created = command({
        sub: 'create',
        channel: box.channel,
        prize: 'book',
        minutes: 5,
        winners: 1,
      })
      await box.runtime.handleInteraction(created.interaction)
      const id = box.sent[0].payload.components[0].toJSON().components[0].custom_id.slice('gw:join:'.length)
      for (const userId of [USER, OTHER_USER]) {
        const join = command({ user: { id: userId, bot: false, createdTimestamp: 0 } })
        join.interaction.isChatInputCommand = () => false
        join.interaction.isButton = () => true
        join.interaction.customId = `gw:join:${id}`
        await box.runtime.handleInteraction(join.interaction)
      }
      await box.runtime.handleInteraction(command({ sub: 'cancel', id }).interaction)
      const data = await box.store.read()
      assert.equal(data.guilds[GUILD][id].status, 'cancelled')
      assert.deepEqual(data.guilds[GUILD][id].winnerIds, [])
      assert.equal(box.draws(), 0)
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('the ready handler is registered and settles a due giveaway', async () => {
    const box = harness()
    try {
      const created = command({
        sub: 'create',
        channel: box.channel,
        prize: 'lamp',
        minutes: 1,
        winners: 1,
      })
      await box.runtime.handleInteraction(created.interaction)
      const id = Object.keys((await box.store.read()).guilds[GUILD])[0]
      await box.store.update((data) => {
        data.guilds[GUILD][id].endAt = 1
        data.guilds[GUILD][id].entries = [USER]
        data.guilds[GUILD][id].announcePending = false
      })
      const client = {
        on(event, fn) {
          this.handlers[event] = fn
        },
        once(event, fn) {
          this.onceHandlers[event] = fn
        },
        handlers: {},
        onceHandlers: {},
        user: { tag: 'Bot#0001' },
      }
      box.runtime.bind(client)
      assert.equal(typeof client.handlers[Events.InteractionCreate], 'function')
      client.onceHandlers[Events.ClientReady]({ user: { tag: 'Bot#0001' } })
      await new Promise((resolve) => setTimeout(resolve, 30))
      const data = await box.store.read()
      assert.equal(data.guilds[GUILD][id].status, 'ended')
      assert.deepEqual(data.guilds[GUILD][id].winnerIds, [USER])
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('reroll keeps the same winners when Discord retries the interaction', async () => {
    const box = harness()
    try {
      const created = command({
        sub: 'create',
        channel: box.channel,
        prize: 'pen',
        minutes: 5,
        winners: 1,
      })
      await box.runtime.handleInteraction(created.interaction)
      const id = box.sent[0].payload.components[0].toJSON().components[0].custom_id.slice('gw:join:'.length)
      for (const userId of [USER, OTHER_USER]) {
        const join = command({ user: { id: userId, bot: false, createdTimestamp: 0 } })
        join.interaction.isChatInputCommand = () => false
        join.interaction.isButton = () => true
        join.interaction.customId = `gw:join:${id}`
        await box.runtime.handleInteraction(join.interaction)
      }
      await box.runtime.handleInteraction(command({ sub: 'end', id }).interaction)
      const afterEnd = box.draws()
      const reroll = command({ sub: 'reroll', giveawayId: id, interactionId: 'reroll-1' })
      await box.runtime.handleInteraction(reroll.interaction)
      await box.runtime.handleInteraction(reroll.interaction)
      assert.equal(box.draws(), afterEnd + 1)
      assert.match(reroll.replies.at(-1).content, /Rerolled/)
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('a crash after send reuses the existing message instead of posting again', async () => {
    const box = harness()
    const original = box.store.update.bind(box.store)
    let crash = true
    box.store.update = (mutator) => original(async (data) => {
      const result = await mutator(data)
      if (crash) {
        for (const guild of Object.values(data.guilds ?? {})) {
          for (const item of Object.values(guild ?? {})) {
            if (item.messageId) {
              crash = false
              throw new Error('crash before persist')
            }
          }
        }
      }
      return result
    })
    try {
      const created = command({
        sub: 'create',
        channel: box.channel,
        prize: 'hat',
        minutes: 5,
        winners: 1,
      })
      await box.runtime.handleInteraction(created.interaction)
      assert.equal(box.sent.length, 1)
      assert.match(created.replies.at(-1).content, /post failed/)
      const saved = await createJsonStore(box.dir.path('giveaways.json')).read()
      const id = Object.keys(saved.guilds[GUILD])[0]
      assert.equal(saved.guilds[GUILD][id].messageId, null)
      box.history.push({
        id: box.sent[0].message.id,
        content: box.sent[0].payload.content,
        author: { id: '999999999999999999' },
        createdTimestamp: saved.guilds[GUILD][id].createdAt,
      })
      const restarted = createRuntime({
        configStore: config(),
        store: createJsonStore(box.dir.path('giveaways.json')),
        now: () => 1_000_000,
        randomInt: () => { throw new Error('redraw') },
        fetchGuild: async () => box.guild,
      })
      await restarted.tick()
      restarted.shutdown()
      assert.equal(box.sent.length, 1)
      const again = await createJsonStore(box.dir.path('giveaways.json')).read()
      assert.equal(again.guilds[GUILD][id].messageId, box.sent[0].message.id)
      assert.equal(again.guilds[GUILD][id].announcePending, false)
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('an incomplete history scan does not send a second announcement', async () => {
    const box = harness()
    try {
      const created = command({
        sub: 'create',
        channel: box.channel,
        prize: 'hat',
        minutes: 5,
        winners: 1,
      })
      await box.runtime.handleInteraction(created.interaction)
      const saved = await box.store.read()
      const id = Object.keys(saved.guilds[GUILD])[0]
      await box.store.update((data) => {
        data.guilds[GUILD][id].messageId = null
        data.guilds[GUILD][id].announcePending = true
      })
      const page = Array.from({ length: 100 }, (_, index) => ({
        id: `newer-${index}`,
        content: 'unrelated',
        author: { id: '999999999999999999' },
        createdTimestamp: saved.guilds[GUILD][id].createdAt + 10_000,
      }))
      box.history.splice(0, box.history.length, ...page)
      await assert.rejects(() => box.runtime.settle(GUILD, id), /incomplete/)
      assert.equal(box.sent.length, 1)
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('a timer and an end command share one draw', async () => {
    const box = harness()
    try {
      const created = command({
        sub: 'create',
        channel: box.channel,
        prize: 'hat',
        minutes: 5,
        winners: 1,
      })
      await box.runtime.handleInteraction(created.interaction)
      const id = box.sent[0].payload.components[0].toJSON().components[0].custom_id.slice('gw:join:'.length)
      const join = command({ user: { id: USER, bot: false, createdTimestamp: 0 } })
      join.interaction.isChatInputCommand = () => false
      join.interaction.isButton = () => true
      join.interaction.customId = `gw:join:${id}`
      await box.runtime.handleInteraction(join.interaction)
      await box.store.update((data) => {
        data.guilds[GUILD][id].endAt = 1
        data.guilds[GUILD][id].announcePending = false
      })
      const before = box.draws()
      await Promise.all([
        box.runtime.settle(GUILD, id),
        box.runtime.handleInteraction(command({ sub: 'end', id }).interaction),
      ])
      assert.equal(box.draws(), before + 1)
      assert.equal(box.sent.length, 1)
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('a long-lived giveaway still sends its first post in a busy channel', async () => {
    const box = harness()
    const id = 'abc123abc123'
    try {
      await box.store.update((data) => {
        data.guilds = {
          [GUILD]: {
            [id]: {
              id,
              guildId: GUILD,
              channelId: CHANNEL,
              messageId: null,
              prize: 'long',
              winnerCount: 1,
              endAt: 1,
              createdBy: USER,
              requiredRoleId: null,
              minAccountAgeMs: 0,
              entries: [USER],
              status: 'open',
              winnerIds: [],
              announcePending: true,
              rerolls: [],
              delivery: 'unsent',
              createdAt: 0,
              endedAt: null,
            },
          },
        }
      })
      box.history.push(...Array.from({ length: 600 }, (_, index) => ({
        id: `busy-${index}`,
        content: 'unrelated',
        author: { id: '999999999999999999' },
        createdTimestamp: 50_000,
      })))
      await box.runtime.settle(GUILD, id)
      assert.equal(box.sent.length, 1)
      assert.equal(box.sent[0].payload.enforceNonce, true)
      assert.equal(box.sent[0].payload.nonce, `g${id}`)
      const saved = await box.store.read()
      assert.deepEqual(saved.guilds[GUILD][id].winnerIds, [USER])
      assert.equal(saved.guilds[GUILD][id].delivery, 'sent')
      const winners = [...saved.guilds[GUILD][id].winnerIds]
      await box.store.update((data) => {
        data.guilds[GUILD][id].messageId = null
        data.guilds[GUILD][id].delivery = 'sending'
        data.guilds[GUILD][id].announcePending = true
      })
      box.channel.messages.fetch = async () => {
        throw new Error('history down')
      }
      await assert.rejects(() => box.runtime.settle(GUILD, id), /could not be checked/)
      assert.equal(box.sent.length, 1)
      const after = await box.store.read()
      assert.deepEqual(after.guilds[GUILD][id].winnerIds, winners)
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })

  test('a lost file lease does not send or edit a giveaway', async () => {
    const box = harness()
    const id = 'abc123abc123'
    try {
      await box.store.update((data) => {
        data.guilds = {
          [GUILD]: {
            [id]: {
              id,
              guildId: GUILD,
              channelId: CHANNEL,
              messageId: 'message-9',
              prize: 'long',
              winnerCount: 1,
              endAt: 1,
              createdBy: USER,
              requiredRoleId: null,
              minAccountAgeMs: 0,
              entries: [USER],
              status: 'ended',
              winnerIds: [USER],
              announcePending: true,
              rerolls: [],
              delivery: 'sent',
              createdAt: 0,
              endedAt: 1,
            },
          },
        }
      })
      const locked = createRuntime({
        configStore: config(),
        store: box.store,
        now: () => 1_000_000,
        fetchGuild: async () => box.guild,
        lock: {
          assertHeld() {
            const error = new Error('lost')
            error.code = 'LEASE_LOST'
            throw error
          },
        },
      })
      await assert.rejects(() => locked.settle(GUILD, id), (error) => error.code === 'LEASE_LOST')
      assert.equal(box.sent.length, 0)
      assert.equal(box.edits.length, 0)
      locked.shutdown()
    } finally {
      box.runtime.shutdown()
      box.dir.remove()
    }
  })
})
