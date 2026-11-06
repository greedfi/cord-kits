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
const ROLE_A = '444444444444444444'
const ROLE_B = '555555555555555555'
const OUTSIDE = '666666666666666666'
const USER = '777777777777777777'

function configStore() {
  return {
    get: () => ({ maxOptions: 25, guilds: { [GUILD]: { managerRoleId: null, maxOptions: 5 } } }),
    onReload() { return () => {} },
    close() {},
  }
}

function role(id, { position = 1, grants = [], managed = false } = {}) {
  const granted = new Set(grants)
  return {
    id,
    position,
    managed,
    permissions: {
      has(bit) {
        for (const name of granted) {
          if (PermissionFlagsBits[name] === bit) return true
        }
        return false
      },
    },
  }
}

function harness() {
  const dir = tempDir()
  const held = new Map([[OUTSIDE, { id: OUTSIDE }]])
  const calls = { add: [], remove: [] }
  const roles = new Map([
    [ROLE_A, role(ROLE_A)],
    [ROLE_B, role(ROLE_B)],
  ])
  const member = {
    id: USER,
    roles: {
      cache: held,
      async add(ids) {
        calls.add.push([...ids])
        for (const id of ids) held.set(id, { id })
      },
      async remove(ids) {
        calls.remove.push([...ids])
        for (const id of ids) held.delete(id)
      },
    },
  }
  let botCanManage = true
  const sent = []
  const channel = {
    id: CHANNEL,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor() { return { has: () => true } },
    async send(payload) {
      sent.push(payload)
      return { id: 'message-1' }
    },
    messages: { async edit(id, payload) { sent.push({ edit: id, payload }) } },
  }
  const guild = {
    id: GUILD,
    members: {
      me: {
        permissions: { has: () => botCanManage },
        roles: { highest: { position: 10 } },
      },
      async fetch(id) {
        if (id !== USER) {
          const error = new Error('unknown')
          error.code = 10007
          throw error
        }
        return member
      },
      async fetchMe() { return this.me },
    },
    roles: {
      async fetch(id) { return roles.get(id) ?? null },
    },
    channels: {
      cache: new Map([[CHANNEL, channel]]),
      async fetch() { return channel },
    },
  }
  const store = createJsonStore(dir.path('panels.json'))
  const runtime = createRuntime({
    configStore: configStore(),
    store,
    fetchGuild: async (id) => {
      if (id !== GUILD) throw new Error('wrong guild')
      return guild
    },
  })
  return {
    dir, held, calls, roles, sent, channel, store, runtime, guild,
    setBotCanManage(value) { botCanManage = value },
  }
}

function command(partial) {
  const replies = []
  const interaction = {
    commandName: 'roles',
    guild: { id: partial.guildId ?? GUILD },
    user: { id: USER, bot: false },
    member: partial.member ?? { permissions: { has: (bit) => bit === PermissionFlagsBits.ManageRoles }, roleIds: [] },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => partial.button !== true && partial.select !== true,
    isButton: () => partial.button === true,
    isStringSelectMenu: () => partial.select === true,
    customId: partial.customId,
    values: partial.values,
    options: {
      getSubcommand: () => partial.sub,
      getString: (name) => partial[name] ?? null,
      getBoolean: (name) => partial[name] ?? null,
      getInteger: (name) => partial[name] ?? null,
      getChannel: () => partial.channel,
      getRole: () => partial.role ?? null,
    },
    async reply(payload) { this.replied = true; replies.push(payload) },
    async deferReply() { this.deferred = true },
    async editReply(payload) { replies.push(typeof payload === 'string' ? { content: payload } : payload) },
    async followUp(payload) { replies.push(payload) },
  }
  return { interaction, replies }
}

async function makePanel(box, { exclusive = true, max = 2, style = 'buttons' } = {}) {
  const created = command({
    sub: 'create',
    channel: box.channel,
    style,
    exclusive,
    max_roles: max,
    title: 'Pick @everyone',
  })
  await box.runtime.handleInteraction(created.interaction)
  const id = created.replies[0].content.match(/`([0-9a-f]{16})`/)[1]
  return id
}

describe('reaction role runtime', () => {
  test('refuses management without Manage Roles and refuses an elevated role', async () => {
    const box = harness()
    try {
      const denied = command({
        sub: 'create',
        member: { permissions: { has: () => false }, roleIds: [] },
        channel: box.channel,
        style: 'buttons',
        exclusive: false,
        max_roles: 1,
        title: 'Roles',
      })
      await box.runtime.handleInteraction(denied.interaction)
      assert.match(denied.replies[0].content, /Manage Roles/)
      const id = await makePanel(box, { exclusive: false, max: 2 })
      const elevated = command({
        sub: 'add',
        panel: id,
        role: role(ROLE_A, { grants: ['Administrator'] }),
        label: 'Admin',
      })
      await box.runtime.handleInteraction(elevated.interaction)
      assert.match(elevated.replies[0].content, /privileged/)
      assert.equal(box.calls.add.length, 0)
    } finally {
      box.dir.remove()
    }
  })

  test('exclusive clicks, deleted roles, stale ids, and a restart stay inside one guild', async () => {
    const box = harness()
    try {
      const id = await makePanel(box, { exclusive: true, max: 5 })
      for (const [roleId, label] of [[ROLE_A, 'A'], [ROLE_B, 'B']]) {
        await box.runtime.handleInteraction(command({
          sub: 'add',
          panel: id,
          role: role(roleId),
          label,
        }).interaction)
      }
      await box.runtime.handleInteraction(command({ sub: 'publish', panel: id }).interaction)
      assert.match(box.sent[0].content, /@\u200beveryone/)
      assert.deepEqual(box.sent[0].allowedMentions, { parse: [] })
      const click = (roleId) => command({
        button: true,
        customId: `rr:t:${id}:${roleId}`,
      })
      await Promise.all([
        box.runtime.handleInteraction(click(ROLE_A).interaction),
        box.runtime.handleInteraction(click(ROLE_B).interaction),
      ])
      const mine = [...box.held.keys()].filter((roleId) => roleId === ROLE_A || roleId === ROLE_B)
      assert.equal(mine.length, 1)
      assert.equal(box.held.has(OUTSIDE), true)
      box.roles.delete(ROLE_A)
      const deleted = click(ROLE_A)
      await box.runtime.handleInteraction(deleted.interaction)
      assert.match(deleted.replies.at(-1).content, /deleted/)
      const saved = await box.store.read()
      assert.equal(saved.guilds[GUILD][id].options.some((option) => option.roleId === ROLE_A), false)
      const stale = command({ button: true, customId: 'rr:t:aaaaaaaaaaaaaaaa:444444444444444444' })
      await box.runtime.handleInteraction(stale.interaction)
      assert.match(stale.replies[0].content, /no longer active/)
      const foreign = command({ button: true, guildId: OTHER, customId: `rr:t:${id}:${ROLE_B}` })
      await box.runtime.handleInteraction(foreign.interaction)
      assert.match(foreign.replies[0].content, /no longer active/)
      const restarted = createRuntime({
        configStore: configStore(),
        store: createJsonStore(box.dir.path('panels.json')),
        fetchGuild: async () => box.guild,
      })
      const client = {
        handlers: {},
        on(event, fn) { this.handlers[event] = fn },
        once(event, fn) { this.handlers[event] = fn },
      }
      restarted.bind(client)
      assert.equal(typeof client.handlers[Events.InteractionCreate], 'function')
      const before = box.calls.add.length + box.calls.remove.length
      await restarted.handleInteraction(click(ROLE_B).interaction)
      assert.equal(box.calls.add.length + box.calls.remove.length, before + 1)
    } finally {
      box.dir.remove()
    }
  })

  test('a select menu replaces panel roles and the ready listener is registered', async () => {
    const box = harness()
    try {
      const id = await makePanel(box, { exclusive: false, max: 2, style: 'select' })
      await box.runtime.handleInteraction(command({ sub: 'add', panel: id, role: role(ROLE_A), label: 'A' }).interaction)
      await box.runtime.handleInteraction(command({ sub: 'add', panel: id, role: role(ROLE_B), label: 'B' }).interaction)
      box.held.set(ROLE_A, { id: ROLE_A })
      const select = command({ select: true, customId: `rr:s:${id}`, values: [ROLE_B] })
      await box.runtime.handleInteraction(select.interaction)
      assert.equal(box.held.has(ROLE_A), false)
      assert.equal(box.held.has(ROLE_B), true)
      assert.equal(box.held.has(OUTSIDE), true)
      box.setBotCanManage(false)
      const blocked = command({ button: true, customId: `rr:t:${id}:${ROLE_B}` })
      const adds = box.calls.add.length
      await box.runtime.handleInteraction(blocked.interaction)
      assert.match(blocked.replies.at(-1).content, /Manage Roles/)
      assert.equal(box.calls.add.length, adds)
      const client = {
        handlers: {},
        on(event, fn) { this.handlers[event] = fn },
        once(event, fn) { this.handlers[event] = fn },
      }
      box.runtime.bind(client)
      assert.equal(typeof client.handlers[Events.InteractionCreate], 'function')
      assert.equal(typeof client.handlers[Events.ClientReady], 'function')
    } finally {
      box.dir.remove()
    }
  })
})
