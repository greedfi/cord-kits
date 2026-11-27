import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice'
import { readFileSync, writeFileSync } from 'node:fs'
import { ChannelType, PermissionFlagsBits, Routes } from 'discord.js'
import { pickRelated } from '../src/autoplay.js'
import { DJ_COMMANDS } from '../src/access.js'
import { redact } from '../src/env.js'
import { ffmpegArgs, FILTERS } from '../src/filters.js'
import { gatewayIntents } from '../src/index.js'
import { GatewayIntentBits } from 'discord.js'
import { acquireLock } from '../src/lock.js'
import { embedCharacterCount, buildPlayerMessage, buildSearchMessage } from '../src/nowplaying.js'
import { createPlaylists } from '../src/playlists.js'
import { progressBar, positionMs } from '../src/progress.js'
import {
  cycleLoop,
  insertManyFront,
  moveTrack,
  removeAt,
  safeLabel,
  toggleShuffle,
} from '../src/queue.js'
import { createSessionStore } from '../src/sessions.js'
import { inspectRequest, handleRequestMessage } from '../src/request.js'
import { interpretQuery } from '../src/sources.js'
import { createPresenter } from '../src/present.js'
import { createVoiceStatus, voiceStatusText } from '../src/voice-status.js'
import { SET_VOICE_CHANNEL_STATUS, REQUEST_CHANNEL_PERMISSIONS, VOICE_STATUS_PERMISSIONS } from '../src/permissions.js'
import { createDiscordVoice } from '../src/voice.js'
import { tempDir } from './helpers.js'
import { GUILD, track } from './harness.js'

describe('queue edges and progress', () => {
  test('move, remove, insert, and shuffle edges', () => {
    const state = {
      current: track({ title: 'Now' }),
      tracks: [track({ title: 'A' }), track({ title: 'B' }), track({ title: 'C' })],
      volume: 10,
      loop: 'off',
      shuffle: false,
      previous: [],
    }
    assert.equal(moveTrack(state, 1, 1).state, state)
    assert.equal(moveTrack(state, 0, 1).ok, false)
    assert.equal(moveTrack(state, 1, 4).ok, false)
    assert.equal(removeAt(state, 0).ok, false)
    const inserted = insertManyFront(state, [track({ title: 'Z' }), track({ title: 'Y' })], 4)
    assert.deepEqual(inserted.accepted.map((item) => item.title), ['Z'])
    assert.equal(inserted.rejected, 1)
    assert.equal(cycleLoop(cycleLoop(cycleLoop({ loop: 'off' }))).loop, 'off')
    const once = toggleShuffle({ ...state, tracks: [track({ title: 'Only' })] }, () => 0)
    assert.equal(once.tracks[0].title, 'Only')
    assert.equal(safeLabel('@everyone <@123> *hi*').includes('@'), false)
    assert.equal(safeLabel('@everyone <@123> *hi*').includes('<'), false)
  })

  test('nightcore progress moves at 1.2x and the bar stays bounded', () => {
    assert.equal(positionMs({ originMs: 0, startedAt: 0, now: 10_000, tempo: FILTERS.nightcore.tempo }), 12_000)
    assert.equal(positionMs({ originMs: 4000, startedAt: 0, now: 5000, paused: true, tempo: 1.2 }), 4000)
    const bar = progressBar(10_000, 20_000, 20)
    assert.equal(bar.includes('['), true)
    assert.equal(progressBar(1000, null), '0:01 / live')
  })
})

describe('autoplay guard', () => {
  test('skips the current track, the queue, and anything already seen', () => {
    const current = track({ url: 'https://soundcloud.com/a/now', soundcloudId: '1' })
    const waiting = [track({ url: 'https://soundcloud.com/a/wait', soundcloudId: '2' })]
    const pick = pickRelated([
      current,
      waiting[0],
      track({ url: 'https://soundcloud.com/a/old', soundcloudId: '3' }),
      track({ url: 'https://soundcloud.com/a/new', soundcloudId: '4' }),
    ], { current, waiting, previous: [], seen: ['3', 'https://soundcloud.com/a/old'] })
    assert.equal(pick.soundcloudId, '4')
    assert.equal(pickRelated([current], { current, waiting: [], previous: [], seen: [] }), null)
  })
})

describe('filters', () => {
  test('only the allowlisted graphs are passed to ffmpeg', () => {
    const args = ffmpegArgs({
      url: 'https://cdn.example.com/a.mp3',
      seekSeconds: 3,
      filter: 'bassboost',
    })
    assert.equal(args.includes('bass=g=8:f=110:w=0.6'), true)
    assert.equal(args.at(-1), 'pipe:1')
    assert.equal(args.includes('https://cdn.example.com/a.mp3'), true)
    const night = ffmpegArgs({ url: 'https://cdn.example.com/a.mp3', filter: 'nightcore' })
    assert.equal(night.includes('asetrate=57600,aresample=48000'), true)
    const wide = ffmpegArgs({ url: 'https://cdn.example.com/a.mp3', filter: '8d' })
    assert.equal(wide.includes('apulsator=hz=0.08'), true)
    assert.throws(() => ffmpegArgs({ url: 'https://cdn.example.com/a.mp3', filter: 'bass;touch /tmp/x' }))
    assert.throws(() => ffmpegArgs({ url: 'file:///etc/passwd', filter: 'off' }))
  })
})

describe('player message limits', () => {
  test('clamps embeds, buttons, and select options', () => {
    const payload = buildPlayerMessage({
      current: true,
      title: `@everyone ${'A'.repeat(500)}`,
      positionMs: 1000,
      durationMs: 5000,
      paused: false,
      volume: 40,
      loop: 'song',
      shuffle: true,
      waiting: 3,
      filter: 'off',
      requestedBy: '<@123> Pat',
      artworkUrl: null,
    })
    const embed = payload.embeds[0]
    assert.ok(embed.title.length <= 256)
    assert.equal(embed.title.includes('@'), false)
    assert.ok(embed.description.length <= 4096)
    assert.ok(embedCharacterCount(embed) <= 6000)
    assert.ok(payload.components.length <= 5)
    for (const row of payload.components) {
      assert.ok(row.components.length <= 5)
      for (const component of row.components) {
        assert.ok(component.custom_id.length <= 100)
        assert.ok(component.label.length <= 80)
      }
    }
    assert.deepEqual(payload.allowedMentions, { parse: [] })
    const menu = buildSearchMessage('abc', Array.from({ length: 12 }, (_item, index) => ({
      title: 'T'.repeat(180),
      url: `https://soundcloud.com/a/${index}`,
      durationMs: 1000,
    })))
    const options = menu.components[0].components[0].options
    assert.equal(options.length, 10)
    assert.ok(options.every((option) => option.label.length <= 100 && option.value.length <= 100))
    assert.equal(menu.components[0].components[0].custom_id, 'ck:pick:abc')
  })
})

describe('playlists survive restart', () => {
  test('backup restores a corrupt file and a double failure does not overwrite', async () => {
    const dir = tempDir()
    const file = dir.path('playlists.json')
    const first = createPlaylists(file)
    await first.create(GUILD, '10', 'mix')
    await first.addTracks(GUILD, '10', false, 'mix', [track({ title: 'Kept' })])
    await first.addTracks(GUILD, '10', false, 'mix', [track({ title: 'Also', url: 'https://cdn.example.com/also.mp3' })])
    const good = readFileSync(file)
    writeFileSync(file, '{')
    const restored = createPlaylists(file)
    assert.equal(restored.show(GUILD, 'mix').tracks[0].title, 'Kept')
    writeFileSync(file, '{')
    const again = createPlaylists(file)
    assert.equal(again.show(GUILD, 'mix').tracks[0].title, 'Kept')
    writeFileSync(file, '{')
    writeFileSync(`${file}.bak`, '{')
    const broken = createPlaylists(file)
    const before = readFileSync(file)
    await assert.rejects(() => broken.create(GUILD, '10', 'nope'), /damaged/)
    assert.deepEqual(readFileSync(file), before)
    writeFileSync(file, good)
    dir.remove()
  })

  test('enforces count and size limits', async () => {
    const dir = tempDir()
    const lists = createPlaylists(dir.path('playlists.json'))
    for (let index = 0; index < 25; index += 1) await lists.create(GUILD, '10', `p${index}`)
    await assert.rejects(() => lists.create(GUILD, '10', 'overflow'), /25/)
    const tracks = Array.from({ length: 101 }, (_item, index) => track({
      title: `T${index}`,
      url: `https://cdn.example.com/${index}.mp3`,
    }))
    const added = await lists.addTracks(GUILD, '10', false, 'p0', tracks)
    assert.equal(added.added, 100)
    assert.equal(added.rejected, 1)
    dir.remove()
  })
})

describe('sessions and the process lock', () => {
  test('session state is still there after a new store opens the directory', async () => {
    const dir = tempDir()
    const file = dir.path('sessions.json')
    const first = createSessionStore(file)
    await first.set(GUILD, { voiceChannelId: '444444444444444444', hold: false })
    const second = createSessionStore(file)
    assert.equal(second.get(GUILD).voiceChannelId, '444444444444444444')
    dir.remove()
  })

  test('a live lock blocks a second process and a dead pid is replaced', () => {
    const dir = tempDir()
    const first = acquireLock(dir.dir)
    assert.throws(() => acquireLock(dir.dir), /Another music process/)
    first.release()
    const again = acquireLock(dir.dir)
    again.release()
    writeFileSync(`${dir.dir}/process.lock`, '99999999\n')
    const taken = acquireLock(dir.dir)
    taken.release()
    dir.remove()
  })
})

describe('request channel flag', () => {
  test('ignores messages when the flag is off and plays when it is on', async () => {
    const settings = { requestChannelId: '333333333333333333', requestAutoDelete: true, maxQueueSize: 10 }
    assert.equal(inspectRequest({
      guildId: GUILD,
      channelId: settings.requestChannelId,
      content: 'a song name',
      author: { bot: false },
    }, { enabled: false, settings }).action, 'ignore')
    assert.equal(inspectRequest({
      guildId: GUILD,
      channelId: '999999999999999999',
      content: 'a song name',
      author: { bot: false },
    }, { enabled: true, settings }).reason, 'channel')
    const played = []
    const deleted = []
    const message = {
      guildId: GUILD,
      channelId: settings.requestChannelId,
      content: 'check https://cdn.example.com/song.mp3',
      author: { id: '10', bot: false, username: 'User' },
      member: {
        permissions: { has: () => false },
        roles: { cache: { has: () => false } },
        voice: {
          channel: {
            id: '444444444444444444',
            type: ChannelType.GuildVoice,
            permissionsFor: () => ({ has: () => true }),
          },
        },
      },
      channel: { send: async () => ({ delete() {} }) },
      async delete() { deleted.push(true) },
    }
    const result = await handleRequestMessage(message, {
      requestChannelEnabled: true,
      configStore: { get: () => ({ guilds: { [GUILD]: settings }, maxQueueSize: 10, defaultVolume: 40 }) },
      sources: { async search() { throw new Error('name search') }, async expand() { return [] } },
      music: {
        bindText() {},
        async play(_guild, _voice, tracks) { played.push(tracks[0].url) },
      },
    })
    assert.equal(result.action, 'play')
    assert.equal(played[0], 'https://cdn.example.com/song.mp3')
    assert.equal(deleted.length, 1)
    const ignored = await handleRequestMessage(message, {
      requestChannelEnabled: false,
      configStore: { get: () => ({ guilds: { [GUILD]: settings } }) },
      sources: { async search() { throw new Error('should not search') } },
      music: { bindText() {}, async play() { throw new Error('should not play') } },
    })
    assert.equal(ignored.action, 'ignore')
  })
})

describe('voice process cleanup and status', () => {
  test('destroy kills ffmpeg and the voice connection', async () => {
    const killed = []
    const events = {}
    const connection = {
      state: { status: VoiceConnectionStatus.Ready },
      joinConfig: { channelId: '444444444444444444' },
      subscribe() {},
      destroy() { this.destroyed = true },
      on() {},
    }
    const player = {
      on(event, fn) { events[event] = fn },
      stop() { events[AudioPlayerStatus.Idle]?.() },
      play() {},
      pause() {},
      unpause() {},
    }
    let idles = 0
    const voice = createDiscordVoice({
      joinVoiceChannel: () => connection,
      createAudioPlayer: () => player,
      createAudioResource: () => ({ volume: { setVolume() {} }, playStream: new PassThrough() }),
      entersState: async () => {},
      spawn(_cmd, args, options) {
        assert.equal(options.shell, false)
        assert.equal(args.includes('https://cdn.example.com/a.mp3'), true)
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = () => { child.killed = true; killed.push(args) }
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    })
    voice.setHandlers({ onIdle() { idles += 1 }, onDisconnect() {} })
    await voice.join({ id: '444444444444444444', guild: { id: GUILD, voiceAdapterCreator: {} } })
    await voice.play(GUILD, { url: 'https://cdn.example.com/a.mp3', seekSeconds: 0, filter: 'off', volume: 50 })
    assert.equal(idles, 0)
    voice.destroy(GUILD)
    assert.equal(killed.length, 1)
    assert.equal(connection.destroyed, true)
    events[AudioPlayerStatus.Idle]?.()
    assert.equal(idles, 0)
  })

  test('a resource failure kills the ffmpeg process', async () => {
    const killed = []
    const voice = createDiscordVoice({
      joinVoiceChannel: () => ({
        state: { status: VoiceConnectionStatus.Ready },
        joinConfig: { channelId: '444444444444444444' },
        subscribe() {},
        destroy() {},
        on() {},
      }),
      createAudioPlayer: () => ({ on() {}, stop() {}, play() {}, pause() {}, unpause() {} }),
      createAudioResource: () => { throw new Error('bad resource') },
      entersState: async () => {},
      spawn() {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = () => { killed.push(true) }
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    })
    await voice.join({ id: '444444444444444444', guild: { id: GUILD, voiceAdapterCreator: {} } })
    await assert.rejects(
      () => voice.play(GUILD, { url: 'https://cdn.example.com/a.mp3', filter: 'off', volume: 40, seekSeconds: 0 }),
      /bad resource/,
    )
    assert.equal(killed.length, 1)
  })

  test('voice status is skipped without the permission and sent when it is held', async () => {
    assert.equal(SET_VOICE_CHANNEL_STATUS, 1n << 48n)
    assert.equal(PermissionFlagsBits.SetVoiceChannelStatus, 1n << 48n)
    assert.equal(REQUEST_CHANNEL_PERMISSIONS, 3222528n)
    assert.equal(VOICE_STATUS_PERMISSIONS, 281474979859456n)
    const puts = []
    const rest = { async put(route, body) { puts.push({ route, body }) } }
    const status = createVoiceStatus(rest, { log: { error() {} } })
    const denied = await status.update({
      id: '444444444444444444',
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => ({ has: () => false }),
    }, 'Song')
    assert.equal(denied.reason, 'permission')
    assert.equal(puts.length, 0)
    const allowed = await status.update({
      id: '444444444444444444',
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => ({ has: (bit) => bit === SET_VOICE_CHANNEL_STATUS }),
    }, 'Song')
    assert.equal(allowed.ok, true)
    assert.equal(puts[0].route, Routes.channelVoiceStatus('444444444444444444'))
    assert.equal(puts[0].body.body.status, voiceStatusText('Song'))
    rest.put = async () => { throw Object.assign(new Error('nope'), { status: 403 }) }
    const failed = await status.update({
      id: '444444444444444444',
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => ({ has: () => true }),
    }, 'Song')
    assert.equal(failed.reason, 'request')
  })
})

describe('presenter and intents', () => {
  test('a deleted player message is sent again and a 429 is swallowed', async () => {
    const sent = []
    const sessions = {
      saved: { textChannelId: '333333333333333333', messageId: 'old' },
      get() { return this.saved },
      set(_id, patch) { this.saved = { ...this.saved, ...patch } },
    }
    const channel = {
      messages: {
        async fetch() {
          return { id: 'old', async edit() { throw Object.assign(new Error('gone'), { code: 10008 }) } }
        },
      },
      async send(body) {
        sent.push(body)
        return { id: 'new', async edit() { throw Object.assign(new Error('rate'), { status: 429 }) } }
      },
    }
    const present = createPresenter({ fetchChannel: async () => channel, sessions })
    await present(GUILD, { embeds: [], components: [] })
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].allowedMentions, { parse: [] })
    await present(GUILD, { embeds: [{ title: 'x' }] })
    assert.equal(sent.length, 1)
  })

  test('message content is not a base intent', () => {
    const base = gatewayIntents(false)
    assert.equal(base.includes(GatewayIntentBits.MessageContent), false)
    assert.equal(base.includes(GatewayIntentBits.Guilds), true)
    assert.equal(base.includes(GatewayIntentBits.GuildVoiceStates), true)
    assert.equal(gatewayIntents(true).includes(GatewayIntentBits.MessageContent), true)
  })
})

describe('closed catalogs and redaction', () => {
  test('spotify and apple links are rejected and secrets are redacted', () => {
    assert.throws(() => interpretQuery('https://open.spotify.com/track/abc'), /Spotify/)
    assert.throws(() => interpretQuery('https://music.apple.com/us/album/x'), /Apple/)
    assert.equal(interpretQuery('a quiet song').mode, 'search')
    const previousToken = process.env.DISCORD_BOT_TOKEN
    const previousClient = process.env.SOUNDCLOUD_CLIENT_ID
    process.env.DISCORD_BOT_TOKEN = 'tok-123'
    process.env.SOUNDCLOUD_CLIENT_ID = 'cid-456'
    try {
      const text = redact('failed tok-123 client_id=cid-456&x=1')
      assert.equal(text.includes('tok-123'), false)
      assert.equal(text.includes('cid-456'), false)
    } finally {
      if (previousToken === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = previousToken
      if (previousClient === undefined) delete process.env.SOUNDCLOUD_CLIENT_ID
      else process.env.SOUNDCLOUD_CLIENT_ID = previousClient
    }
  })

  test('DJ command names in the schema match the code list', () => {
    const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'))
    const schemaPath = schema.properties.guilds.additionalProperties.properties.djOnly.items.enum
    assert.deepEqual(schemaPath, DJ_COMMANDS)
  })
})
