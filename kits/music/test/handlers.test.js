import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageFlags, PermissionFlagsBits } from 'discord.js'
import { createApp } from '../src/handlers.js'
import { gatewayIntents } from '../src/permissions.js'
import { attachClient } from '../src/runtime.js'
import { baseConfig, memoryConfig, mockInteraction, stubMusic } from './mock.js'

function appFor(extra = {}) {
  const music = extra.music ?? stubMusic()
  const config = extra.config ?? memoryConfig(structuredClone(baseConfig))
  const panels = extra.panels ?? {
    async show() { return { channelId: '222222222222222222', messageId: '1' } },
    async save() {},
    get() { return null },
    ids() { return [] },
  }
  const progress = { async push() {}, mark() {}, stop() {} }
  const sent = []
  const app = createApp({
    config,
    music,
    playlists: extra.playlists,
    panels,
    progress,
    requestChannel: extra.requestChannel ?? false,
    now: extra.now ?? (() => 5_000),
    resolveTracks: extra.resolveTracks ?? (async () => [{
      kind: 'direct',
      title: 'Song',
      url: 'https://cdn.example.com/song.mp3',
      durationMs: 10_000,
    }]),
  })
  return { app, music, config, sent, panels, progress }
}

describe('interaction routing', () => {
  test('a search menu plays the chosen track and ignores an expired menu', async () => {
    let now = 5_000
    const music = stubMusic()
    const { app } = appFor({
      music,
      now: () => now,
      resolveTracks: async () => [
        { kind: 'soundcloud', title: 'First', url: 'https://soundcloud.com/a/first' },
        { kind: 'soundcloud', title: 'Second', url: 'https://soundcloud.com/a/second' },
      ],
    })
    const search = mockInteraction({
      commandName: 'search',
      options: { query: 'song' },
      botChannelId: null,
    })
    await app.handleInteraction(search.interaction)
    const pick = mockInteraction({
      kind: 'select',
      customId: 'search:pick',
      values: ['1'],
      botChannelId: null,
    })
    await app.handleInteraction(pick.interaction)
    const played = music.calls.find((call) => call[0] === 'play')
    assert.equal(played[3][0].title, 'Second')
    now = 5_000 + 6 * 60 * 1000
    const late = mockInteraction({
      kind: 'select',
      customId: 'search:pick',
      values: ['0'],
      botChannelId: null,
    })
    const before = music.calls.length
    await app.handleInteraction(late.interaction)
    assert.equal(music.calls.length, before)
    assert.match(late.replies[0].payload.content, /expired/)
  })

  test('defers a play before the resolver finishes and keeps guilds apart', async () => {
    let release
    const pending = new Promise((resolve) => { release = resolve })
    const { app, music } = appFor({ resolveTracks: () => pending })
    const first = mockInteraction({ commandName: 'play', options: { query: 'calm song' }, botChannelId: null })
    const run = app.handleInteraction(first.interaction)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(first.interaction.deferred, true)
    assert.equal(music.calls.length, 0)
    release([{ kind: 'direct', title: 'Song', url: 'https://cdn.example.com/song.mp3' }])
    await run
    assert.equal(music.calls[0][0], 'play')
    assert.equal(music.calls[0][1], '111111111111111111')

    const second = mockInteraction({
      commandName: 'play',
      guildId: '222222222222222222',
      options: { query: 'other' },
      botChannelId: null,
    })
    const other = appFor({ music })
    await other.app.handleInteraction(second.interaction)
    assert.equal(music.calls.at(-1)[1], '222222222222222222')
  })

  test('DJ, text, voice, and button checks reject before changing playback', async () => {
    const { app, music } = appFor()
    const member = mockInteraction({
      commandName: 'skip',
      botChannelId: '444444444444444444',
    })
    await app.handleInteraction(member.interaction)
    assert.equal(music.calls.length, 0)
    assert.match(member.replies[0].payload.content, /DJ role/)

    const button = mockInteraction({
      kind: 'button',
      customId: 'np:skip',
      botChannelId: '444444444444444444',
    })
    await app.handleInteraction(button.interaction)
    assert.equal(music.calls.length, 0)
    assert.equal(button.interaction.deferred, false)
    assert.match(button.replies[0].payload.content, /DJ role/)

    const manager = mockInteraction({
      kind: 'button',
      customId: 'np:skip',
      botChannelId: '444444444444444444',
      permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Connect],
    })
    await app.handleInteraction(manager.interaction)
    assert.equal(music.calls.at(-1)[0], 'skip')

    const config = memoryConfig(structuredClone(baseConfig))
    config.update((draft) => {
      draft.guilds['111111111111111111'].textChannels = ['222222222222222222']
      draft.guilds['111111111111111111'].voiceChannels = ['454444444444444444']
    })
    const limited = appFor({ config, music })
    const wrongText = mockInteraction({ commandName: 'queue', channelId: '666666666666666666' })
    await limited.app.handleInteraction(wrongText.interaction)
    assert.match(wrongText.replies[0].payload.content, /text channel/)
    const wrongVoice = mockInteraction({
      commandName: 'play',
      options: { query: 'song' },
      botChannelId: null,
    })
    await limited.app.handleInteraction(wrongVoice.interaction)
    assert.match(wrongVoice.replies[0].payload.content, /voice channel/)
    const settings = mockInteraction({
      commandName: 'setdj',
      options: { clear: true },
      permissions: [PermissionFlagsBits.ManageGuild],
    })
    await limited.app.handleInteraction(settings.interaction)
    assert.equal(config.get().guilds['111111111111111111'].djRoleId, null)
  })

  test('the request channel does nothing until the flag is on, then gates messages and commands', async () => {
    const config = memoryConfig(structuredClone(baseConfig))
    config.update((draft) => {
      draft.guilds['111111111111111111'].requestChannelId = '222222222222222222'
      draft.guilds['111111111111111111'].requestCommandsOnly = true
      draft.guilds['111111111111111111'].requestAutoDelete = true
    })
    const music = stubMusic()
    const off = appFor({ config, music, requestChannel: false })
    const setup = mockInteraction({
      commandName: 'setup',
      permissions: [PermissionFlagsBits.ManageGuild],
      options: { channel: { id: '222222222222222222' } },
    })
    await off.app.handleInteraction(setup.interaction)
    assert.match(setup.replies[0].payload.content, /ENABLE_REQUEST_CHANNEL/)
    const ignored = {
      guildId: '111111111111111111',
      channelId: '222222222222222222',
      author: { id: '333333333333333333', bot: false, username: 'ada' },
      member: { voice: { channel: { id: '444444444444444444', type: 2 } }, permissions: { has: () => false }, roles: { cache: { has: () => false } } },
      content: 'secret-song-name',
      guild: { members: { me: {} } },
      channel: { send: async () => {}, permissionsFor: () => ({ has: () => false }) },
      delete: async () => { throw new Error('deleted while disabled') },
    }
    await off.app.handleMessage(ignored)
    assert.equal(music.calls.length, 0)

    let deleted = false
    const on = appFor({ config, music, requestChannel: true })
    const message = {
      ...ignored,
      delete: async () => { deleted = true },
      channel: {
        id: '222222222222222222',
        send: async (body) => body,
        permissionsFor: () => ({ has: () => true }),
      },
      guild: { members: { me: { id: 'bot' } } },
    }
    await on.app.handleMessage(message)
    assert.equal(music.calls.at(-1)[0], 'play')
    assert.equal(deleted, true)
    const notices = []
    const yanked = {
      ...message,
      delete: async () => { throw new Error('should not delete') },
      member: {
        ...message.member,
        voice: { channel: { id: '454444444444444444', type: 2, permissionsFor: () => ({ has: () => true }) } },
      },
      guild: { members: { me: { id: 'bot', voice: { channelId: '444444444444444444' } } } },
      channel: {
        ...message.channel,
        send: async (body) => { notices.push(body); return body },
      },
    }
    const before = music.calls.length
    await on.app.handleMessage(yanked)
    assert.equal(music.calls.length, before)
    assert.match(notices.at(-1).content, /another voice channel/)
    const elsewhere = mockInteraction({
      commandName: 'play',
      channelId: '666666666666666666',
      options: { query: 'song' },
      botChannelId: null,
    })
    await on.app.handleInteraction(elsewhere.interaction)
    assert.match(elsewhere.replies[0].payload.content, /request channel/)
    assert.equal(gatewayIntents(false).some((bit) => bit === 32768), false)
    const client = { events: {}, on(name, fn) { this.events[name] = fn } }
    attachClient(client, { app: on.app, requestChannel: false })
    assert.equal(client.events.messageCreate, undefined)
    attachClient(client, { app: on.app, requestChannel: true })
    assert.equal(typeof client.events.messageCreate, 'function')
  })

  test('a failed resolver after defer is acknowledged with a safe error', async () => {
    const errors = []
    const original = console.error
    console.error = (line) => errors.push(String(line))
    try {
      const { app } = appFor({
        resolveTracks: async () => {
          throw new Error('https://api.example/secret?client_id=abcdef')
        },
      })
      const { interaction, replies } = mockInteraction({
        commandName: 'play',
        options: { query: 'secret-song-name' },
        botChannelId: null,
      })
      await app.handleInteraction(interaction)
      assert.equal(interaction.deferred, true)
      assert.equal(replies.at(-1).payload.content, 'Command failed.')
      assert.equal(errors.join('\n').includes('secret-song-name'), false)
    } finally {
      console.error = original
    }
  })

  test('play is refused when View Channel, Connect, or Speak is missing', async () => {
    const cases = [
      ['View Channel', PermissionFlagsBits.ViewChannel, 'play'],
      ['Connect', PermissionFlagsBits.Connect, 'play'],
      ['Speak', PermissionFlagsBits.Speak, 'join'],
    ]
    for (const [label, bit, commandName] of cases) {
      const { app, music } = appFor()
      const command = mockInteraction({
        commandName,
        options: { query: 'song' },
        botChannelId: null,
        voiceChannel: {
          id: '444444444444444444',
          type: 2,
          permissionsFor() {
            return { has: (flag) => flag !== bit }
          },
        },
      })
      await app.handleInteraction(command.interaction)
      assert.equal(music.calls.length, 0, label)
      assert.equal(command.replies[0].type, 'reply')
      assert.equal(command.replies[0].payload.flags, MessageFlags.Ephemeral)
      assert.match(command.replies[0].payload.content, new RegExp(`I need ${label} in <#444444444444444444>`))
      assert.match(command.replies[0].payload.content, /category permissions/)
    }
  })

  test('a category overwrite that denies View Channel blocks the join', async () => {
    const { app, music } = appFor()
    const command = mockInteraction({
      commandName: 'play',
      options: { query: 'song' },
      botChannelId: null,
      permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
      voiceChannel: {
        id: '444444444444444444',
        type: 2,
        permissionsFor() {
          return { has: (flag) => flag !== PermissionFlagsBits.ViewChannel }
        },
      },
    })
    await app.handleInteraction(command.interaction)
    assert.equal(music.calls.length, 0)
    assert.equal(command.replies[0].payload.flags, MessageFlags.Ephemeral)
    assert.match(command.replies[0].payload.content, /I need View Channel in <#444444444444444444>/)
  })
})
