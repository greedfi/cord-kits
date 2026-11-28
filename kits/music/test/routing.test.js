import { readFileSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { createConfigStore, loadSchema } from '../src/config.js'
import { createApp } from '../src/handlers.js'
import { resolveTracks } from '../src/resolve.js'
import { createPlaylistStore } from '../src/playlists.js'
import { silentLogger, tempDir } from './helpers.js'
import { baseConfig, memoryConfig, mockInteraction, stubMusic } from './mock.js'

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
        options: { channel: { id: '222222222222222222', type: 0 } },
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
      const playfile = mockInteraction({
        commandName: 'setdjonly',
        options: { command: 'playfile', enabled: true },
        permissions: manage,
      })
      await app.handleInteraction(playfile.interaction)
      assert.match(text(playfile.replies), /playfile/)
      assert.equal(config.get().guilds[guild].djOnly.includes('playfile'), true)
      assert.deepEqual(config.get().guilds[guild].textChannels, ['222222222222222222'])
      assert.deepEqual(config.get().guilds[guild].voiceChannels, ['444444444444444444'])
      assert.equal(config.get().guilds[guild].defaultVolume, 15)
    } finally {
      dir.remove()
    }
  })

  test('play auto-detects a name, SoundCloud, a file, and a radio stream, and playfile queues an attachment', async () => {
    const music = stubMusic()
    const seen = []
    const clientId = 'a'.repeat(32)
    const fetchImpl = async (url) => {
      const address = String(url)
      const track = address.includes('/search/tracks')
        ? {
          collection: [{
            kind: 'track',
            id: 9,
            title: 'Dancing Queen',
            permalink_url: 'https://soundcloud.com/abba/dancing-queen',
            user: { username: 'ABBA' },
          }],
        }
        : {
          kind: 'track',
          id: 4,
          title: 'Song',
          permalink_url: 'https://soundcloud.com/artist/song',
          user: { username: 'Artist' },
        }
      return { ok: true, status: 200, async json() { return track } }
    }
    const requestImpl = async () => ({
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'icy-name': 'Station' },
    })
    const app = createApp({
      config: memoryConfig(structuredClone(baseConfig)),
      music,
      requestChannel: false,
      now: () => 1_000,
      resolveTracks: (input) => {
        seen.push(input)
        return resolveTracks(input, { fetchImpl, requestImpl, clientId, lookup: async () => [{ address: '1.1.1.1', family: 4 }] })
      },
    })
    const cases = [
      { commandName: 'play', options: { query: 'dancing queen' } },
      { commandName: 'play', options: { query: 'https://soundcloud.com/artist/song' } },
      { commandName: 'play', options: { query: 'https://cdn.example.com/song.mp3' } },
      { commandName: 'play', options: { query: 'https://radio.example.com/station' } },
      {
        commandName: 'playfile',
        options: {
          file: {
            url: 'https://cdn.discordapp.com/attachments/1/2/voice.mp3',
            name: 'voice.mp3',
            contentType: 'audio/mpeg',
            size: 1000,
          },
        },
      },
    ]
    for (const item of cases) {
      const command = mockInteraction({ ...item, botChannelId: null })
      await app.handleInteraction(command.interaction)
    }
    assert.deepEqual(seen.map((input) => input.query ?? input.attachment.name), [
      'dancing queen',
      'https://soundcloud.com/artist/song',
      'https://cdn.example.com/song.mp3',
      'https://radio.example.com/station',
      'voice.mp3',
    ])
    assert.equal(seen.some((input) => input.kind != null), false)
    const played = music.calls.filter((call) => call[0] === 'play')
    assert.equal(played.length, 5)
    assert.equal(played[0][3][0].kind, 'soundcloud')
    assert.equal(played[0][3][0].title, 'Dancing Queen')
    assert.equal(played[1][3][0].kind, 'soundcloud')
    assert.equal(played[1][3][0].url, 'https://soundcloud.com/artist/song')
    assert.equal(played[2][3][0].kind, 'direct')
    assert.equal(played[3][3][0].kind, 'radio')
    assert.equal(played[4][3][0].kind, 'attachment')
    assert.equal(played[4][4], 'end')
  })

  test('playfile follows the DJ and voice permission checks for play', async () => {
    const music = stubMusic()
    const config = memoryConfig(structuredClone(baseConfig))
    config.update((draft) => {
      draft.guilds[guild].djOnly = ['play']
    })
    const app = createApp({
      config,
      music,
      requestChannel: false,
      now: () => 1_000,
      resolveTracks: async () => [{ kind: 'attachment', title: 'Voice', url: 'https://cdn.discordapp.com/a.mp3' }],
    })
    const file = {
      url: 'https://cdn.discordapp.com/attachments/1/2/voice.mp3',
      name: 'voice.mp3',
      contentType: 'audio/mpeg',
      size: 1000,
    }
    const denied = mockInteraction({
      commandName: 'playfile',
      options: { file },
      botChannelId: null,
    })
    await app.handleInteraction(denied.interaction)
    assert.match(text(denied.replies), /DJ role/)
    assert.equal(music.calls.length, 0)
    const quiet = mockInteraction({
      commandName: 'playfile',
      options: { file },
      botChannelId: null,
      roles: ['555555555555555555'],
      voiceChannel: {
        id: '444444444444444444',
        type: 2,
        permissionsFor() {
          return { has: (bit) => bit !== PermissionFlagsBits.Speak }
        },
      },
    })
    await app.handleInteraction(quiet.interaction)
    assert.match(text(quiet.replies), /I need Speak in <#444444444444444444>/)
    assert.equal(music.calls.length, 0)
  })

  test('/setdjonly command:playfile saves', async () => {
    const dir = tempDir()
    const filePath = dir.path('config.json')
    writeFileSync(filePath, readFileSync(new URL('../config.example.json', import.meta.url)))
    const config = createConfigStore({
      filePath,
      schema: loadSchema(fileURLToPath(new URL('../config.schema.json', import.meta.url))),
      logger: silentLogger,
      watch: false,
    })
    const app = createApp({
      config,
      music: stubMusic(),
      requestChannel: false,
      now: () => 1_000,
    })
    const command = mockInteraction({
      commandName: 'setdjonly',
      options: { command: 'playfile', enabled: true },
      permissions: [PermissionFlagsBits.ManageGuild],
    })
    try {
      await app.handleInteraction(command.interaction)
      assert.match(text(command.replies), /\/playfile now requires the DJ role/)
      assert.equal(config.get().guilds[guild].djOnly.includes('playfile'), true)
    } finally {
      config.close()
      dir.remove()
    }
  })
})
