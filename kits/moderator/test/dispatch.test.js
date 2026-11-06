// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { execute } from '../src/dispatch.js'
import { createRateLimiter } from '../src/limits.js'

const GUILD = '111111111111111111'
const BOT = '222222222222222222'
const OWNER = '333333333333333333'
const ACTOR = '444444444444444444'
const TARGET = '555555555555555555'

function perms(mask) {
  return {
    has(bit) {
      if ((mask & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) return true
      return (mask & bit) === bit
    },
  }
}

function person({ id, position, tag, mask = 0n }) {
  const calls = { kick: [], timeout: [], ban: [] }
  const member = {
    id,
    user: { id, tag, bot: false },
    roles: { highest: { position } },
    permissions: perms(mask),
    calls,
    async send() {},
    async timeout(_ms, reason) {
      calls.timeout.push(reason)
    },
    async kick(reason) {
      calls.kick.push(reason)
    },
  }
  return member
}

function interaction({ commandName, actor, options, fetch, channel }) {
  const replies = []
  const actorMember = actor
  const guild = {
    id: GUILD,
    name: 'Test',
    ownerId: OWNER,
    channels: { cache: new Map(), fetch: async () => null },
    members: {
      me: person({ id: BOT, position: 10, tag: 'Bot#0001', mask: PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ModerateMembers }),
      async fetch(id) {
        return fetch(id)
      },
      async ban(id, payload) {
        guild.bans.push({ id, payload })
      },
    },
    bans: [],
  }
  const value = {
    commandName,
    guild,
    user: actorMember.user,
    member: actorMember,
    channel: channel ?? null,
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => true,
    options: {
      getUser: (name) => options.user && name === 'user' ? options.user : null,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
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
  }
  return { interaction: value, replies, guild }
}

describe('moderation dispatch', () => {
  test('discord.js treats Administrator as every moderation permission', () => {
    const admin = new PermissionsBitField(PermissionFlagsBits.Administrator)
    assert.equal(admin.has(PermissionFlagsBits.ModerateMembers), true)
    assert.equal(admin.has(PermissionFlagsBits.BanMembers), true)
  })

  test('refuses a visible command when the member lacks the permission', async () => {
    const actor = person({ id: ACTOR, position: 5, tag: 'Mod#0001', mask: 0n })
    const { interaction: command, replies } = interaction({
      commandName: 'warn',
      actor,
      options: { user: { id: TARGET, tag: 'User#0001' }, reason: 'nope' },
      fetch: () => {
        throw new Error('should not fetch')
      },
    })
    const warnings = { add() { throw new Error('should not warn') } }
    await execute(command, { warnings, configStore: { get: () => ({ guilds: {} }) } })
    assert.match(replies[0].content, /do not have permission/)
    assert.equal(command.deferred, false)
  })

  test('warn refuses the owner and does not store a warning', async () => {
    const actor = person({ id: ACTOR, position: 5, tag: 'Mod#0001', mask: PermissionFlagsBits.ModerateMembers })
    const owner = person({ id: OWNER, position: 50, tag: 'Owner#0001' })
    const { interaction: command, replies } = interaction({
      commandName: 'warn',
      actor,
      options: { user: owner.user, reason: 'no' },
      fetch: async (id) => (id === OWNER ? owner : actor),
    })
    let added = 0
    await execute(command, {
      warnings: { add() { added += 1 } },
      configStore: { get: () => ({ guilds: {} }) },
    })
    assert.equal(added, 0)
    assert.match(replies.at(-1).content, /owner/)
  })

  test('a transient member lookup does not ban, and unknown member does', async () => {
    const actor = person({ id: ACTOR, position: 5, tag: 'Mod#0001', mask: PermissionFlagsBits.BanMembers })
    const transient = interaction({
      commandName: 'ban',
      actor,
      options: { user: { id: TARGET, tag: 'User#0001' }, reason: 'raid', delete_days: 0 },
      fetch: async () => {
        const error = new Error('upstream')
        error.code = 500
        throw error
      },
    })
    await execute(transient.interaction, { warnings: { add() {} }, configStore: { get: () => ({ guilds: {} }) } })
    assert.equal(transient.guild.bans.length, 0)
    assert.match(transient.replies.at(-1).content, /upstream/)

    const gone = interaction({
      commandName: 'ban',
      actor,
      options: { user: { id: TARGET, tag: 'User#0001' }, reason: 'left', delete_days: 1 },
      fetch: async () => {
        const error = new Error('unknown')
        error.code = 10007
        throw error
      },
    })
    await execute(gone.interaction, { warnings: { add() {} }, configStore: { get: () => ({ guilds: {} }) } })
    assert.equal(gone.guild.bans.length, 1)
    assert.equal(gone.guild.bans[0].payload.deleteMessageSeconds, 86400)
    assert.match(gone.guild.bans[0].payload.reason, new RegExp(`^By ${ACTOR}:`))
  })

  test('kick records the moderator id in the Discord reason', async () => {
    const actor = person({ id: ACTOR, position: 5, tag: 'Mod#0001', mask: PermissionFlagsBits.KickMembers })
    const target = person({ id: TARGET, position: 1, tag: 'User#0001' })
    const { interaction: command } = interaction({
      commandName: 'kick',
      actor,
      options: { user: target.user, reason: 'spam' },
      fetch: async (id) => (id === TARGET ? target : actor),
    })
    await execute(command, { warnings: { add() {} }, configStore: { get: () => ({ guilds: {} }) } })
    assert.match(target.calls.kick[0], new RegExp(`^By ${ACTOR}: spam`))
  })

  test('purge checks the channel permission, not only the command default', async () => {
    const actor = person({ id: ACTOR, position: 5, tag: 'Mod#0001', mask: PermissionFlagsBits.ManageMessages })
    let fetched = 0
    const channel = {
      id: '666666666666666666',
      isDMBased: () => false,
      permissionsFor(member) {
        return { has: () => member.id !== ACTOR }
      },
      messages: { fetch: async () => { fetched += 1; return new Map() } },
      bulkDelete() { throw new Error('should not delete') },
    }
    const { interaction: command, replies } = interaction({
      commandName: 'purge',
      actor,
      options: { count: 5 },
      fetch: async () => actor,
      channel,
    })
    await execute(command, { warnings: { add() {} }, configStore: { get: () => ({ guilds: {} }) } })
    assert.equal(fetched, 0)
    assert.match(replies.at(-1).content, /You need Manage Messages/)
  })

  test('the sixth command in the window is refused', async () => {
    const actor = person({ id: ACTOR, position: 5, tag: 'Mod#0001', mask: PermissionFlagsBits.ModerateMembers })
    const target = person({ id: TARGET, position: 1, tag: 'User#0001' })
    let added = 0
    const limiter = createRateLimiter({ limit: 5, windowMs: 15_000, now: () => 10_000 })
    const ctx = {
      commandLimiter: limiter,
      warnings: { add() { added += 1; return { count: added } } },
      configStore: { get: () => ({ guilds: {} }) },
    }
    for (let i = 0; i < 5; i += 1) {
      const { interaction: command } = interaction({
        commandName: 'warn',
        actor,
        options: { user: target.user, reason: 'note' },
        fetch: async (id) => (id === TARGET ? target : actor),
      })
      await execute(command, ctx)
    }
    const blocked = interaction({
      commandName: 'warn',
      actor,
      options: { user: target.user, reason: 'note' },
      fetch: async () => { throw new Error('should not fetch') },
    })
    await execute(blocked.interaction, ctx)
    assert.equal(added, 5)
    assert.match(blocked.replies[0].content, /too quickly/)
    assert.equal(blocked.interaction.deferred, false)
  })
})
