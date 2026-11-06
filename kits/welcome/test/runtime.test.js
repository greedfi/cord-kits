// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Events, PermissionFlagsBits } from 'discord.js'
import { joinDecision, roleBlock } from '../src/roles.js'
import { createRuntime } from '../src/runtime.js'
import { createJsonStore } from '../src/store.js'
import { tempDir } from './helpers.js'

const GUILD = '111111111111111111'
const USER = '222222222222222222'
const CHANNEL = '333333333333333333'
const ROLE = '444444444444444444'

function role(id, grants = []) {
  return {
    id,
    position: 1,
    managed: false,
    permissions: {
      has(bit) {
        return grants.some((name) => PermissionFlagsBits[name] === bit)
      },
    },
  }
}

describe('welcome runtime', () => {
  test('screening, rejoin, rules acceptance, and privileged roles', async () => {
    assert.equal(joinDecision({ pending: true, user: { bot: false } }), 'screening')
    assert.equal(roleBlock(role(ROLE, ['Administrator']), {
      botHasManageRoles: true, botHighest: 10, guildId: GUILD,
    }).reason, 'elevated')
    const dir = tempDir()
    const sent = []
    const added = []
    const roles = new Map([[ROLE, role(ROLE)]])
    const channel = { id: CHANNEL, async send(payload) { sent.push(payload) } }
    function person(partial) {
      const held = new Set(partial.roleIds ?? [])
      return {
        id: partial.id ?? USER,
        pending: partial.pending ?? false,
        user: { bot: false },
        guild: {
          id: GUILD,
          name: 'Test @everyone',
          memberCount: 3,
          channels: { cache: new Map([[CHANNEL, channel]]), async fetch() { return channel } },
          members: { me: { permissions: { has: () => partial.botCan !== false }, roles: { highest: { position: 10 } } } },
          roles: { async fetch(id) { return roles.get(id) ?? null } },
        },
        roles: {
          cache: held,
          async add(id) { added.push(id); held.add(id) },
        },
        get roleIds() { return [...held] },
      }
    }
    const store = createJsonStore(dir.path('welcome.json'))
    const config = {
      get: () => ({
        guilds: {
          [GUILD]: {
            welcomeChannelId: CHANNEL,
            leaveChannelId: CHANNEL,
            welcomeMessage: 'Welcome {user} to {guild}.',
            leaveMessage: '{user} left.',
            autoRoleId: ROLE,
            rulesRoleId: ROLE,
          },
        },
      }),
      onReload() { return () => {} },
    }
    const runtime = createRuntime({ configStore: config, store })
    try {
      const pending = person({ pending: true })
      assert.equal((await runtime.onJoin(pending)).action, 'screening')
      assert.equal(sent.length, 0)
      assert.equal(added.length, 0)
      const joined = person({})
      await runtime.onUpdate({ pending: true }, joined)
      assert.equal(sent.length, 1)
      assert.match(sent[0].content, /<@222222222222222222>/)
      assert.match(sent[0].content, /@\u200beveryone/)
      assert.deepEqual(sent[0].allowedMentions.parse, [])
      assert.deepEqual(added, [ROLE])
      await runtime.onUpdate({ pending: false }, joined)
      assert.equal(sent.length, 1)
      await runtime.onLeave(joined)
      assert.equal(sent.length, 2)
      await runtime.onJoin(person({}))
      assert.equal(sent.length, 3)
      const replies = []
      function accept(partial) {
        return {
          customId: 'welcome:accept',
          guild: person({}).guild,
          member: partial.member,
          user: { id: partial.member.id },
          inGuild: () => true,
          isChatInputCommand: () => false,
          isButton: () => true,
          async reply(payload) { replies.push(payload.content) },
          async followUp(payload) { replies.push(payload.content) },
        }
      }
      const fresh = person({ id: '777777777777777777' })
      await runtime.handleInteraction(accept({ member: fresh }))
      assert.match(replies.at(-1), /not an identity check/)
      assert.equal(added.length, 3)
      await runtime.handleInteraction(accept({ member: fresh }))
      assert.match(replies.at(-1), /already accepted/)
      assert.equal(added.length, 3)
      roles.set(ROLE, role(ROLE, ['ModerateMembers']))
      await runtime.handleInteraction(accept({ member: person({ id: '666666666666666666' }) }))
      assert.match(replies.at(-1), /did not assign/)
      assert.equal(added.length, 3)
      const client = { handlers: {}, on(event, fn) { (this.handlers[event] ??= []).push(fn) }, once() {} }
      runtime.bind(client)
      assert.equal(client.handlers[Events.GuildMemberAdd].length, 1)
      assert.equal(client.handlers[Events.GuildMemberRemove].length, 1)
      const source = await import('node:fs')
      const index = source.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
      assert.match(index, /INTENTS/)
      assert.doesNotMatch(index, /membershipScreening|MessageContent/)
    } finally {
      dir.remove()
    }
  })
})
