import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { createApp } from '../src/handlers.js'
import { createPlaylistStore } from '../src/playlists.js'
import { baseConfig, memoryConfig, mockInteraction, stubMusic } from './mock.js'
import { tempDir } from './helpers.js'

const guild = '111111111111111111'

function text(replies) {
  return replies.map((entry) => entry.payload?.content).filter(Boolean).join('\n')
}

describe('command routing', () => {
  test('playlist play is refused when play is DJ-only', async () => {
    const music = stubMusic()
    const dir = tempDir()
    const playlists = createPlaylistStore({ file: dir.path('playlists.json') })
    playlists.create({ guildId: guild, ownerId: '333333333333333333', name: 'Night' })
    playlists.addTracks({
      guildId: guild,
      actorId: '333333333333333333',
      manage: false,
      name: 'Night',
      tracks: [{ kind: 'direct', title: 'Song', url: 'https://cdn.example.com/a.mp3' }],
    })
    const config = memoryConfig(structuredClone(baseConfig))
    config.update((draft) => {
      draft.guilds[guild].djOnly = ['play']
    })
    const app = createApp({
      config,
      music,
      playlists,
      requestChannel: false,
      now: () => 1_000,
      resolveTracks: async () => [{ kind: 'direct', title: 'Song', url: 'https://cdn.example.com/a.mp3' }],
    })
    const denied = mockInteraction({
      commandName: 'playlist',
      options: { subcommand: 'play', name: 'Night' },
      botChannelId: null,
    })
    await app.handleInteraction(denied.interaction)
    assert.match(text(denied.replies), /DJ role/)
    assert.equal(music.calls.some((call) => call[0] === 'play'), false)
    const allowed = mockInteraction({
      commandName: 'playlist',
      options: { subcommand: 'play', name: 'Night' },
      botChannelId: null,
      roles: ['555555555555555555'],
    })
    await app.handleInteraction(allowed.interaction)
    assert.equal(music.calls.some((call) => call[0] === 'play'), true)
    dir.remove()
  })

  test('pause defers before a play that is holding the guild lock', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const music = stubMusic()
    music.play = () => gate.then(() => ({ ok: true, message: 'Playing **Song**.' }))
    const app = createApp({
      config: memoryConfig(structuredClone(baseConfig)),
      music,
      requestChannel: false,
      now: () => 1_000,
      resolveTracks: () => gate.then(() => [{
        kind: 'direct',
        title: 'Song',
        url: 'https://cdn.example.com/a.mp3',
      }]),
    })
    const play = mockInteraction({
      commandName: 'play',
      options: { query: 'song' },
      botChannelId: null,
    })
    const playing = app.handleInteraction(play.interaction)
    await new Promise((resolve) => setImmediate(resolve))
    const pause = mockInteraction({
      commandName: 'pause',
      botChannelId: '444444444444444444',
    })
    const pausing = app.handleInteraction(pause.interaction)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(pause.interaction.deferred, true)
    release()
    await playing
    await pausing
    assert.equal(music.calls.some((call) => call[0] === 'pause'), true)
  })

  test('routes pause, resume, seek, settings, dj, toggles, sleep, and playlist commands', async () => {
    const dir = tempDir()
    const music = stubMusic()
    const playlists = createPlaylistStore({ file: dir.path('playlists.json') })
    const config = memoryConfig(structuredClone({
      ...baseConfig,
      guilds: {
        [guild]: {
          djRoleId: null,
          djOnly: [],
          textChannels: [],
          voiceChannels: [],
        },
      },
    }))
    const app = createApp({
      config,
      music,
      playlists,
      panels: {
        async show() { return { channelId: '222222222222222222', messageId: '1' } },
        async save() {},
        get() { return null },
        ids() { return [] },
      },
      requestChannel: false,
      now: () => 5_000,
      resolveTracks: async () => [{
        kind: 'direct',
        title: 'Song',
        url: 'https://cdn.example.com/a.mp3',
        durationMs: 30_000,
      }],
    })
    const manage = [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Connect]
    const cases = [
      { commandName: 'pause', botChannelId: '444444444444444444', call: 'pause' },
      { commandName: 'resume', botChannelId: '444444444444444444', call: 'resume' },
      {
        commandName: 'seek',
        botChannelId: '444444444444444444',
        options: { position: '1:30' },
        call: 'seek',
        args: 90_000,
      },
      {
        commandName: 'sleep',
        botChannelId: '444444444444444444',
        options: { minutes: 5 },
        call: 'sleep',
      },
      {
        commandName: 'settings',
        options: { subcommand: 'show' },
        permissions: manage,
        reply: /Volume/,
      },
      {
        commandName: 'settings',
        options: { subcommand: 'volume', level: 15 },
        permissions: manage,
        reply: /15/,
      },
      {
        commandName: 'setdjonly',
        options: { command: 'skip', enabled: true },
        permissions: manage,
        reply: /skip/,
      },
      {
        commandName: 'texttoggle',
        options: { channel: { id: '222222222222222222' } },
        permissions: manage,
        reply: /allowed/,
      },
      {
        commandName: 'voicetoggle',
        options: { channel: { id: '444444444444444444' } },
        permissions: manage,
        reply: /allowed/,
      },
      {
        commandName: 'playlist',
        options: { subcommand: 'create', name: 'Night' },
        permissions: [PermissionFlagsBits.Connect],
        reply: /Created/,
      },
      {
        commandName: 'playlist',
        options: { subcommand: 'add', name: 'Night', query: 'song' },
        permissions: [PermissionFlagsBits.Connect],
        reply: /Added/,
      },
      {
        commandName: 'playlist',
        options: { subcommand: 'show', name: 'Night' },
        permissions: [PermissionFlagsBits.Connect],
        reply: /Night/,
      },
      {
        commandName: 'playlist',
        options: { subcommand: 'remove', name: 'Night', index: 1 },
        permissions: [PermissionFlagsBits.Connect],
        reply: /Removed/,
      },
      {
        commandName: 'playlist',
        options: { subcommand: 'delete', name: 'Night' },
        permissions: [PermissionFlagsBits.Connect],
        reply: /Deleted/,
      },
    ]
    try {
      for (const item of cases) {
        const { interaction, replies } = mockInteraction(item)
        await app.handleInteraction(interaction)
        if (item.call) {
          const match = music.calls.find((call) => call[0] === item.call)
          assert.ok(match, item.commandName)
          if (item.args != null) assert.equal(match[2], item.args)
        }
        if (item.reply) assert.match(text(replies), item.reply, item.commandName)
      }
      assert.equal(config.get().guilds[guild].djOnly.includes('skip'), true)
      assert.deepEqual(config.get().guilds[guild].textChannels, ['222222222222222222'])
      assert.deepEqual(config.get().guilds[guild].voiceChannels, ['444444444444444444'])
      assert.equal(config.get().guilds[guild].defaultVolume, 15)
    } finally {
      dir.remove()
    }
  })
})
