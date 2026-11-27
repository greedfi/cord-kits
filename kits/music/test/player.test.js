import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import { ChannelType } from 'discord.js'
import { createMusic } from '../src/player.js'
import { waitingLimit } from '../src/settings.js'
import { rejoinDelayMs } from '../src/sessions.js'
import { tempDir } from './helpers.js'
import { memoryConfig } from './mock.js'

function track(title, extra = {}) {
  return {
    kind: 'direct',
    title,
    url: `https://cdn.example.com/${title}.mp3`,
    durationMs: 180_000,
    requestedById: '333333333333333333',
    requestedByTag: 'ada',
    ...extra,
  }
}

function voiceChannel(guildId, channelId) {
  return {
    id: channelId,
    type: ChannelType.GuildVoice,
    guild: { id: guildId, voiceAdapterCreator: {}, members: { me: { id: 'bot' } } },
  }
}

function fakeVoice() {
  const connections = []
  const players = []
  return {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    connections,
    players,
    joinVoiceChannel(config) {
      const handlers = {}
      const connection = {
        joinConfig: { channelId: config.channelId, guildId: config.guildId },
        state: { status: VoiceConnectionStatus.Ready },
        subscribe() {},
        destroy() {
          connection.state.status = VoiceConnectionStatus.Destroyed
          handlers.stateChange?.({}, { status: VoiceConnectionStatus.Destroyed })
        },
        on(event, fn) {
          handlers[event] = fn
        },
        emitDisconnect() {
          connection.state.status = VoiceConnectionStatus.Disconnected
          handlers.stateChange?.({}, { status: VoiceConnectionStatus.Disconnected })
        },
      }
      connections.push(connection)
      return connection
    },
    createAudioPlayer() {
      const handlers = {}
      const player = {
        state: { status: AudioPlayerStatus.Idle },
        play() {
          player.state.status = AudioPlayerStatus.Playing
        },
        pause() {
          player.state.status = AudioPlayerStatus.Paused
        },
        unpause() {
          player.state.status = AudioPlayerStatus.Playing
        },
        stop() {
          player.state.status = AudioPlayerStatus.Idle
          handlers[AudioPlayerStatus.Idle]?.()
        },
        on(event, fn) {
          handlers[event] = fn
        },
        emitIdle() {
          handlers[AudioPlayerStatus.Idle]?.()
        },
      }
      players.push(player)
      return player
    },
    createAudioResource(_input, options) {
      return {
        metadata: options?.metadata,
        volume: { level: 1, setVolume(level) { this.level = level } },
      }
    },
    entersState(target, status) {
      if (target.state.status === status) return Promise.resolve(target)
      return Promise.reject(new Error(`wanted ${status}`))
    },
  }
}

function harness(config, extra = {}) {
  const voice = fakeVoice()
  const spawns = []
  const timers = []
  let clock = 1_000
  const music = createMusic(memoryConfig(config), {
    voice,
    now: () => clock,
    schedule(fn, ms) {
      const timer = { fn, ms, cancelled: false, cancel() { this.cancelled = true } }
      timers.push(timer)
      return timer
    },
    spawn(_file, args) {
      const stdout = new PassThrough()
      const child = { stdout, args, killed: false, kill() { this.killed = true; stdout.end() } }
      spawns.push(child)
      return child
    },
    resolveStream: extra.resolveStream ?? (async (item) => item.url),
    relatedTracks: extra.relatedTracks,
    setVoiceStatus: extra.setVoiceStatus,
    fetchChannel: extra.fetchChannel,
    stateStore: extra.stateStore,
  })
  return { music, voice, spawns, timers, setClock(value) { clock = value } }
}

const guild = '111111111111111111'
const other = '222222222222222222'

function playingConfig(extra = {}) {
  return {
    defaultVolume: 40,
    maxQueueSize: 100,
    extendedQueue: false,
    autoplay: false,
    stayConnected: false,
    filter: 'off',
    guilds: {},
    ...extra,
  }
}

describe('player', () => {
  test('keeps guilds apart, seeks inside the track, and refuses the edges', async () => {
    const { music, spawns } = harness(playingConfig())
    await music.play(guild, voiceChannel(guild, '444444444444444444'), [track('A'), track('B')])
    await music.play(other, voiceChannel(other, '454444444444444444'), [track('C')])
    assert.equal(music.snapshot(guild).current.title, 'A')
    assert.equal(music.snapshot(other).current.title, 'C')
    assert.equal(music.snapshot(guild).tracks[0].title, 'B')
    const tooFar = await music.seek(guild, 180_000)
    assert.equal(tooFar.ok, false)
    const radio = await music.play(guild, voiceChannel(guild, '444444444444444444'), [
      track('Live', { kind: 'radio', durationMs: null, url: 'https://radio.example.com/live' }),
    ], 'skip')
    assert.equal(radio.ok, true)
    assert.equal((await music.seek(guild, 1_000)).ok, false)
    await music.play(guild, voiceChannel(guild, '444444444444444444'), [track('A')], 'skip')
    assert.equal((await music.seek(guild, 15_000)).ok, true)
    assert.equal(spawns.at(-1).args.includes('15.000'), true)
    assert.equal(spawns.at(-1).args.includes('-i'), true)
    const rewind = await music.nudge(guild, -20_000)
    assert.equal(rewind.ok, true)
    assert.equal(spawns.at(-1).args.includes('-ss'), false)
    await music.volume(guild, 10)
    assert.equal(music.snapshot(guild).volume, 10)
  })

  test('loop song does not replay a broken track forever, and skip leaves the loop', async () => {
    let fail = false
    let calls = 0
    const { music, voice } = harness(playingConfig(), {
      resolveStream: async (item) => {
        calls += 1
        if (fail) throw new Error('stream down')
        return item.url
      },
    })
    await music.play(guild, voiceChannel(guild, '444444444444444444'), [track('A'), track('B')])
    await music.loop(guild, 'song')
    const before = calls
    fail = true
    voice.players[0].emitIdle()
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(calls - before <= 5)
    assert.equal(music.snapshot(guild).current, null)
    fail = false
    await music.play(guild, voiceChannel(guild, '444444444444444444'), [track('A'), track('B')])
    await music.loop(guild, 'song')
    const skipped = await music.skip(guild)
    assert.equal(skipped.ok, true)
    assert.equal(music.snapshot(guild).current.title, 'B')
  })

  test('autoplay will not repeat a track or an artist, and a status failure still plays', async () => {
    const related = []
    let statusCalls = 0
    let statusLogs = 0
    const original = console.error
    console.error = (...args) => {
      if (args.join(' ').includes('Voice status')) statusLogs += 1
    }
    const { music, voice } = harness(playingConfig({ autoplay: true }), {
      relatedTracks: async () => related.splice(0),
      setVoiceStatus: async () => {
        statusCalls += 1
        throw new Error('status rejected')
      },
    })
    const first = track('A', { kind: 'soundcloud', artist: 'Ada', soundcloudId: '1', url: 'https://soundcloud.com/a/a' })
    const fresh = track('B', { kind: 'soundcloud', artist: 'Bea', soundcloudId: '2', url: 'https://soundcloud.com/a/b' })
    related.push(first, fresh)
    try {
      const played = await music.play(guild, voiceChannel(guild, '444444444444444444'), [first])
      assert.equal(played.ok, true)
      assert.ok(statusCalls >= 1)
      voice.players[0].emitIdle()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(music.snapshot(guild).current.title, 'B')
      assert.ok(statusCalls >= 2)
      assert.equal(statusLogs, 1)
    } finally {
      console.error = original
    }
    related.push(first, fresh)
    voice.players[0].emitIdle()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(music.snapshot(guild).current, null)
  })

  test('24/7 rejoins with backoff, skips a missing channel, and leave does not bounce', async () => {
    const dir = tempDir()
    try {
      const { createStateStore } = await import('../src/sessions.js')
      const store = createStateStore(dir.path('state.json'))
      let missing = false
      const first = harness(playingConfig({ stayConnected: true }), {
        stateStore: store,
        fetchChannel: async (_guildId, channelId) => (
          missing ? null : voiceChannel(guild, channelId)
        ),
      })
      await first.music.play(guild, voiceChannel(guild, '444444444444444444'), [track('A')])
      assert.equal(store.get(guild).channelId, '444444444444444444')
      first.voice.connections[0].emitDisconnect()
      assert.equal(first.timers.at(-1).ms, 1000)
      missing = true
      await first.timers.at(-1).fn()
      assert.equal(store.get(guild).channelId, null)
      assert.equal(first.timers.length, 1)

      missing = false
      const second = harness(playingConfig({ stayConnected: true }), {
        stateStore: store,
        fetchChannel: async () => {
          throw new Error('voice down')
        },
      })
      store.put(guild, { channelId: '444444444444444444', sleepUntil: null })
      await second.music.restore()
      assert.equal(rejoinDelayMs(8), 30_000)
      assert.equal(second.timers[0].ms, rejoinDelayMs(0))
      await second.timers[0].fn()
      assert.equal(second.timers[1].ms, rejoinDelayMs(1))
      assert.ok(second.timers[1].ms > second.timers[0].ms)

      const third = harness(playingConfig({ stayConnected: true }), {
        stateStore: store,
        fetchChannel: async (_guildId, channelId) => voiceChannel(guild, channelId),
      })
      await third.music.play(guild, voiceChannel(guild, '444444444444444444'), [track('A')])
      third.voice.connections[0].emitDisconnect()
      const pending = third.timers.at(-1)
      await third.music.leave(guild)
      assert.equal(pending.cancelled, true)
      third.voice.connections[0].emitDisconnect()
      assert.equal(third.timers.filter((timer) => !timer.cancelled).length, 0)
      assert.equal(third.spawns.some((child) => child.killed), true)
      third.music.destroy()
    } finally {
      dir.remove()
    }
  })

  test('the queue cap stays at 100 until extended and never passes 1000', () => {
    assert.equal(waitingLimit({ maxQueueSize: 500, extendedQueue: false }), 100)
    assert.equal(waitingLimit({ maxQueueSize: 40, extendedQueue: false }), 40)
    assert.equal(waitingLimit({ maxQueueSize: 500, extendedQueue: true }), 500)
    assert.equal(waitingLimit({ maxQueueSize: 5000, extendedQueue: true }), 1000)
  })

  test('a sleep timer leaves and a restart during sleep does not rejoin', async () => {
    const dir = tempDir()
    try {
      const { createStateStore } = await import('../src/sessions.js')
      const store = createStateStore(dir.path('state.json'))
      const { music, timers } = harness(playingConfig({ stayConnected: true }), {
        stateStore: store,
        fetchChannel: async () => voiceChannel(guild, '444444444444444444'),
      })
      await music.join(guild, voiceChannel(guild, '444444444444444444'))
      const armed = await music.sleep(guild, 5)
      assert.equal(armed.ok, true)
      assert.equal(timers.at(-1).ms, 300_000)
      const during = harness(playingConfig({ stayConnected: true }), {
        stateStore: store,
        fetchChannel: async () => {
          throw new Error('should not rejoin')
        },
      })
      await during.music.restore()
      assert.equal(during.voice.connections.length, 0)
      await timers.at(-1).fn()
      await music.settled(guild)
      assert.equal(music.snapshot(guild).connected, false)
    } finally {
      dir.remove()
    }
  })
})
