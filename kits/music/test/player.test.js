import dns from 'node:dns'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import { ChannelType, PermissionFlagsBits } from 'discord.js'
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

function fakeVoice(voiceStatus) {
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
        rejoin(config) {
          connection.joinConfig.channelId = config.channelId ?? connection.joinConfig.channelId
          connection.state.status = VoiceConnectionStatus.Ready
          connection.rejoins = (connection.rejoins ?? 0) + 1
          return true
        },
        emitDisconnect() {
          connection.state.status = VoiceConnectionStatus.Disconnected
          handlers.stateChange?.({}, { status: VoiceConnectionStatus.Disconnected })
        },
      }
      if (voiceStatus) connection.state.status = voiceStatus
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
  const voice = fakeVoice(extra.voiceStatus)
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
      const stderr = new PassThrough()
      const child = new EventEmitter()
      child.stdout = stdout
      child.stderr = stderr
      child.args = args
      child.killed = false
      child.kill = () => {
        child.killed = true
        child.killedByUs = true
        stdout.end()
      }
      spawns.push(child)
      return child
    },
    lookup: extra.lookup ?? (async () => [{ address: '1.1.1.1', family: 4 }]),
    ...(extra.realProbe ? {} : {
      fetchImpl: extra.fetchImpl ?? (async () => ({
        status: 200,
        headers: { get() { return null } },
        body: { async cancel() {} },
      })),
    }),
    ...(extra.spawn ? { spawn: extra.spawn } : {}),
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
    await music.settled(guild)
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
      await music.settled(guild)
      assert.equal(music.snapshot(guild).current.title, 'B')
      assert.ok(statusCalls >= 2)
      assert.equal(statusLogs, 1)
    } finally {
      console.error = original
    }
    related.push(first, fresh)
    voice.players[0].emitIdle()
    await new Promise((resolve) => setImmediate(resolve))
    await music.settled(guild)
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

  test('24/7 rejoins after a voice kick instead of treating the old connection as alive', async () => {
    const dir = tempDir()
    try {
      const { createStateStore } = await import('../src/sessions.js')
      const store = createStateStore(dir.path('state.json'))
      const { music, voice, timers } = harness(playingConfig({ stayConnected: true }), {
        stateStore: store,
        fetchChannel: async (_guildId, channelId) => voiceChannel(guild, channelId),
      })
      await music.join(guild, voiceChannel(guild, '444444444444444444'))
      const connection = voice.connections[0]
      connection.emitDisconnect()
      assert.equal(connection.joinConfig.channelId, '444444444444444444')
      assert.equal(connection.state.status, VoiceConnectionStatus.Disconnected)
      await timers.at(-1).fn()
      assert.equal(connection.rejoins, 1)
      assert.equal(connection.state.status, VoiceConnectionStatus.Ready)
      assert.equal(music.snapshot(guild).connected, true)
    } finally {
      dir.remove()
    }
  })

  test('five failed tracks are cleared so the next play starts', async () => {
    let allow = true
    const { music, voice } = harness(playingConfig(), {
      resolveStream: async (item) => {
        if (!allow || item.title.startsWith('Bad')) throw new Error('dead')
        return item.url
      },
    })
    const channel = voiceChannel(guild, '444444444444444444')
    await music.play(guild, channel, [
      track('Good'),
      track('Bad 1'),
      track('Bad 2'),
      track('Bad 3'),
      track('Bad 4'),
      track('Bad 5'),
    ])
    allow = false
    voice.players[0].emitIdle()
    await new Promise((resolve) => setImmediate(resolve))
    await music.settled(guild)
    assert.equal(music.snapshot(guild).current, null)
    allow = true
    const again = await music.play(guild, channel, [track('After')])
    assert.equal(again.ok, true)
    assert.equal(music.snapshot(guild).current.title, 'After')
  })

  test('a ffmpeg process that exits immediately is not looped, and a missing binary is reported', async () => {
    const { music, spawns } = harness(playingConfig(), {
      spawn(_file, args) {
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const child = new EventEmitter()
        child.stdout = stdout
        child.stderr = stderr
        child.args = args
        child.killed = false
        child.kill = () => { child.killed = true }
        process.nextTick(() => child.emit('exit', 1, null))
        spawns.push(child)
        return child
      },
    })
    await music.loop(guild, 'song')
    await assert.rejects(
      () => music.play(guild, voiceChannel(guild, '444444444444444444'), [track('Loop')]),
      /ffmpeg exited/,
    )
    assert.ok(spawns.length <= 2)
    assert.equal(music.snapshot(guild).current, null)

    const broken = harness(playingConfig(), {
      spawn() {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = () => {}
        process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
        return child
      },
    })
    await assert.rejects(
      () => broken.music.play(guild, voiceChannel(guild, '444444444444444444'), [track('Nope')]),
      /FFMPEG_PATH/,
    )
  })

  test('skip moves past a bad stream, and a cancelled sleep timer cannot drop a later session', async () => {
    const { music, timers } = harness(playingConfig(), {
      resolveStream: async (item) => {
        if (item.title === 'Bad') throw new Error('dead')
        return item.url
      },
    })
    const channel = voiceChannel(guild, '444444444444444444')
    await music.play(guild, channel, [track('Good'), track('Bad')])
    const skipped = await music.skip(guild)
    assert.equal(skipped.ok, true)
    assert.equal(music.snapshot(guild).current, null)
    const next = await music.play(guild, channel, [track('Later')])
    assert.equal(next.ok, true)
    assert.equal(music.snapshot(guild).current.title, 'Later')

    await music.sleep(guild, 1)
    const stale = timers.at(-1)
    await music.leave(guild)
    await music.join(guild, channel)
    await stale.fn()
    assert.equal(music.snapshot(guild).connected, true)
  })

  test('a public hostname that resolves to a private address is not given to ffmpeg', async () => {
    const seen = []
    const { music, spawns } = harness(playingConfig(), {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })
    await assert.rejects(
      () => music.play(guild, voiceChannel(guild, '444444444444444444'), [track('Hidden')]),
      (error) => error.code === 'blocked_host',
    )
    assert.equal(spawns.length, 0)
    const redirected = harness(playingConfig(), {
      fetchImpl: async (url) => {
        seen.push(String(url))
        if (String(url).includes('cdn.example.com')) {
          return {
            status: 302,
            headers: { get: (name) => (name === 'location' ? 'http://10.1.2.3/secret' : null) },
            body: { async cancel() {} },
          }
        }
        return { status: 200, headers: { get: () => null }, body: { async cancel() {} } }
      },
    })
    await assert.rejects(
      () => redirected.music.play(guild, voiceChannel(guild, '444444444444444444'), [track('Hop')]),
      (error) => error.code === 'blocked_host',
    )
    assert.equal(redirected.spawns.length, 0)
    assert.equal(seen.some((url) => url.includes('10.1.2.3')), false)
  })

  test('a timed-out rejoin is dropped and the next backoff attempt continues', async () => {
    const dir = tempDir()
    try {
      const { createStateStore } = await import('../src/sessions.js')
      const store = createStateStore(dir.path('state.json'))
      const { music, voice, timers } = harness(playingConfig({ stayConnected: true }), {
        stateStore: store,
        fetchChannel: async (_guildId, channelId) => voiceChannel(guild, channelId),
      })
      await music.join(guild, voiceChannel(guild, '444444444444444444'))
      const connection = voice.connections[0]
      connection.rejoin = () => {
        connection.state.status = VoiceConnectionStatus.Signalling
        connection.rejoins = (connection.rejoins ?? 0) + 1
        return true
      }
      connection.emitDisconnect()
      await timers.at(-1).fn()
      assert.equal(connection.rejoins, 1)
      assert.equal(music.snapshot(guild).connected, false)
      assert.ok(timers.length >= 2)
      await timers.at(-1).fn()
      assert.equal(music.snapshot(guild).connected, true)
      assert.equal(voice.connections.at(-1).state.status, VoiceConnectionStatus.Ready)
    } finally {
      dir.remove()
    }
  })

  test('a later playback failure is not reported as the first error', async () => {
    let message = 'first failure'
    const { music } = harness(playingConfig(), {
      resolveStream: async () => {
        throw Object.assign(new Error(message), { code: 'blocked_host' })
      },
    })
    const channel = voiceChannel(guild, '444444444444444444')
    await assert.rejects(() => music.play(guild, channel, [track('A')]), /first failure/)
    message = 'second failure'
    await assert.rejects(() => music.play(guild, channel, [track('B')]), /second failure/)
  })

  test('a short ending after seek is not a failure, and a late non-zero exit stops the loop', async () => {
    const { music, voice, spawns, setClock } = harness(playingConfig())
    const channel = voiceChannel(guild, '444444444444444444')
    await music.play(guild, channel, [track('Song')])
    await music.loop(guild, 'song')
    await music.seek(guild, 179_000)
    setClock(1_200)
    const child = spawns.at(-1)
    child.emit('exit', 0, null)
    voice.players[0].emitIdle()
    await new Promise((resolve) => setImmediate(resolve))
    await music.settled(guild)
    assert.equal(music.snapshot(guild).current?.title, 'Song')
    assert.equal(music.snapshot(guild).current?.failed, false)

    const dead = spawns.at(-1)
    voice.players[0].emitIdle()
    dead.emit('exit', 1, null)
    await new Promise((resolve) => setImmediate(resolve))
    await music.settled(guild)
    assert.ok(spawns.length <= 4)
    assert.equal(music.snapshot(guild).current, null)
  })

  test('an endless ICY stream is accepted and the probe socket closes', async () => {
    await withLocalDns(checkIcyProbe)
  })

  test('a real redirect to a private host is refused before ffmpeg', async () => {
    await withLocalDns(checkPrivateRedirect)
  })

  test('24/7 rejoin logs a missing voice permission and waits instead of joining', async () => {
    let allowView = true
    const channel = voiceChannel(guild, '444444444444444444')
    channel.permissionsFor = () => ({
      has: (bit) => bit !== PermissionFlagsBits.ViewChannel || allowView,
    })
    const dir = tempDir()
    const errors = []
    const original = console.error
    console.error = (line) => errors.push(String(line))
    try {
      const { createStateStore } = await import('../src/sessions.js')
      const store = createStateStore(dir.path('state.json'))
      const { music, voice, timers } = harness(playingConfig({ stayConnected: true }), {
        stateStore: store,
        fetchChannel: async () => channel,
      })
      await music.join(guild, channel)
      assert.equal(voice.connections.length, 1)
      allowView = false
      voice.connections[0].emitDisconnect()
      await timers.at(-1).fn()
      assert.equal(voice.connections.length, 1)
      assert.equal(voice.connections[0].rejoins ?? 0, 0)
      assert.match(errors.join('\n'), /I need View Channel in <#444444444444444444>/)
      assert.equal(timers.at(-1).ms, 2_000)
    } finally {
      console.error = original
      dir.remove()
    }
  })

  test('a ready timeout explains signalling and connecting', async () => {
    const errors = []
    const original = console.error
    console.error = (line) => errors.push(String(line))
    try {
      const signalling = harness(playingConfig(), { voiceStatus: VoiceConnectionStatus.Signalling })
      await assert.rejects(
        () => signalling.music.play(guild, voiceChannel(guild, '444444444444444444'), [track('Signal')]),
        /Could not connect to the voice channel/,
      )
      assert.equal(signalling.voice.connections[0].state.status, VoiceConnectionStatus.Destroyed)
      assert.match(errors.join('\n'), /timed out \(signalling\).*permission/)

      errors.length = 0
      const connecting = harness(playingConfig(), { voiceStatus: VoiceConnectionStatus.Connecting })
      await assert.rejects(
        () => connecting.music.play(guild, voiceChannel(guild, '454444444444444444'), [track('Connect')]),
        /Could not connect to the voice channel/,
      )
      assert.equal(connecting.voice.connections[0].state.status, VoiceConnectionStatus.Destroyed)
      assert.match(errors.join('\n'), /timed out \(connecting\).*UDP/)
    } finally {
      console.error = original
    }
  })
})

let dnsTail = Promise.resolve()

function withLocalDns(run) {
  const next = dnsTail.then(run, run)
  dnsTail = next.then(() => {}, () => {})
  return next
}

async function checkIcyProbe() {
  const probe = await openProbe()
  const restore = pointLookup('icy.radio.test', '127.0.0.1')
  try {
    const url = `http://icy.radio.test:${probe.port}/stream`
    const { music, spawns } = harness(playingConfig(), { realProbe: true })
    const result = await music.play(guild, voiceChannel(guild, '444444444444444444'), [
      track('Station', { kind: 'radio', url }),
    ])
    assert.equal(result.ok, true)
    assert.equal(spawns[0].args.includes(url), true)
    assert.equal(await probe.closedSoon(), true)
    assert.ok(probe.bytesWritten() < 256 * 1024)
  } finally {
    restore()
    await probe.close()
  }
}

async function checkPrivateRedirect() {
  const probe = await openProbe()
  const restore = pointLookup('icy.radio.test', '127.0.0.1')
  try {
    const url = `http://icy.radio.test:${probe.port}/redirect`
    const { music, spawns } = harness(playingConfig(), { realProbe: true })
    await assert.rejects(
      () => music.play(guild, voiceChannel(guild, '444444444444444444'), [
        track('Hop', { url }),
      ]),
      (error) => error.code === 'blocked_host',
    )
    assert.equal(spawns.length, 0)
    assert.equal(probe.sinkHits, 0)
    assert.equal(await probe.closedSoon(), true)
  } finally {
    restore()
    await probe.close()
  }
}

function pointLookup(hostname, address) {
  const original = dns.lookup
  dns.lookup = (host, options, callback) => {
    let opts = options
    let done = callback
    if (typeof options === 'function') {
      done = options
      opts = {}
    }
    if (host === hostname) {
      if (opts?.all) done(null, [{ address, family: 4 }])
      else done(null, address, 4)
      return undefined
    }
    return original(host, opts, done)
  }
  return () => {
    dns.lookup = original
  }
}

function openProbe() {
  const seen = []
  let sinkHits = 0
  let sinkPort = 0
  const sink = net.createServer((socket) => {
    sinkHits += 1
    socket.destroy()
  })
  const server = net.createServer((socket) => {
    const record = { socket, bytes: 0, closed: false, opened: Date.now() }
    seen.push(record)
    let request = ''
    let pump = null
    const stop = () => {
      if (pump) clearInterval(pump)
      pump = null
    }
    socket.on('data', (chunk) => {
      request += chunk.toString('latin1')
      if (!request.includes('\r\n\r\n') || record.answered) return
      record.answered = true
      if (request.includes('GET /redirect')) {
        socket.end(
          `HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${sinkPort}/secret\r\nConnection: close\r\n\r\n`,
        )
        return
      }
      socket.write('ICY 200 OK\r\nicy-name: Station\r\n\r\n')
      pump = setInterval(() => {
        if (socket.destroyed) return
        socket.write('x'.repeat(64 * 1024))
      }, 10)
    })
    socket.on('close', () => {
      stop()
      record.closed = true
      record.closedAt = Date.now()
      record.bytes = socket.bytesWritten
    })
    socket.on('error', stop)
  })
  return new Promise((resolve, reject) => {
    sink.once('error', reject)
    sink.listen(0, '127.0.0.1', () => {
      sinkPort = sink.address().port
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: server.address().port,
          get sinkHits() { return sinkHits },
          bytesWritten() { return seen.reduce((sum, item) => sum + (item.bytes || item.socket.bytesWritten), 0) },
          async closedSoon() {
            const deadline = Date.now() + 500
            while (seen.length === 0 || seen.some((item) => !item.closed)) {
              if (Date.now() > deadline) return false
              await new Promise((done) => setTimeout(done, 10))
            }
            return seen.every((item) => item.closedAt - item.opened < 500)
          },
          close() {
            for (const item of seen) item.socket.destroy()
            return Promise.all([
              new Promise((done) => server.close(done)),
              new Promise((done) => sink.close(done)),
            ])
          },
        })
      })
    })
  })
}
