import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PROGRESS_MS } from '../src/limits.js'
import { handleInteraction } from '../src/dispatch.js'
import {
  GUILD,
  OTHER,
  STREAM,
  VOICE,
  createFakeVoice,
  createInteraction,
  createManualTimers,
  member,
  musicKit,
  options,
  track,
  voiceChannel,
} from './harness.js'

const song = () => track()

describe('player', () => {
  test('guilds do not share a queue', async () => {
    const { music } = musicKit()
    const channelA = voiceChannel({ guildId: GUILD })
    const channelB = voiceChannel({ id: '555555555555555555', guildId: OTHER })
    await music.play(GUILD, channelA, [song()])
    assert.equal(music.snapshot(OTHER).current, null)
    assert.equal(music.snapshot(OTHER).tracks.length, 0)
    await music.play(OTHER, channelB, [track({ title: 'Other', url: 'https://cdn.example.com/other.mp3' })])
    assert.equal(music.snapshot(GUILD).current.title, 'Song')
    assert.equal(music.snapshot(OTHER).current.title, 'Other')
    music.destroy()
  })

  test('playtop, playskip, move, remove, and clear', async () => {
    const { music, voice } = musicKit()
    const channel = voiceChannel()
    await music.play(GUILD, channel, [track({ title: 'A', url: 'https://cdn.example.com/a.mp3' })])
    await music.play(GUILD, channel, [
      track({ title: 'B', url: 'https://cdn.example.com/b.mp3' }),
      track({ title: 'C', url: 'https://cdn.example.com/c.mp3' }),
    ])
    await music.play(GUILD, channel, [track({ title: 'D', url: 'https://cdn.example.com/d.mp3' })], 'next')
    assert.deepEqual(music.snapshot(GUILD).tracks.map((item) => item.title), ['D', 'B', 'C'])
    await music.play(GUILD, channel, [track({ title: 'E', url: 'https://cdn.example.com/e.mp3' })], 'now')
    assert.equal(music.snapshot(GUILD).current.title, 'E')
    assert.deepEqual(music.snapshot(GUILD).tracks.map((item) => item.title), ['D', 'B', 'C'])
    music.move(GUILD, 1, 3)
    assert.deepEqual(music.snapshot(GUILD).tracks.map((item) => item.title), ['B', 'C', 'D'])
    music.remove(GUILD, 2)
    assert.deepEqual(music.snapshot(GUILD).tracks.map((item) => item.title), ['B', 'D'])
    assert.throws(() => music.move(GUILD, 0, 1), /not in the queue/)
    assert.throws(() => music.remove(GUILD, 9), /not in the queue/)
    const cleared = music.clear(GUILD)
    assert.equal(cleared.ok, true)
    assert.equal(music.snapshot(GUILD).tracks.length, 0)
    assert.equal(music.snapshot(GUILD).current.title, 'E')
    assert.equal(voice.guilds.get(GUILD).plays.at(-1).url, STREAM)
    music.destroy()
  })

  test('seek, rewind clamp, forward past the end, and radio refusal', async () => {
    const timers = createManualTimers()
    const { music, voice } = musicKit({ clock: timers, timers })
    const channel = voiceChannel()
    await music.play(GUILD, channel, [
      track({ title: 'A', durationMs: 20_000, url: 'https://cdn.example.com/a.mp3' }),
      track({ title: 'B', durationMs: 20_000, url: 'https://cdn.example.com/b.mp3' }),
    ])
    timers.advance(5_000)
    await music.nudge(GUILD, -30)
    assert.equal(voice.guilds.get(GUILD).plays.at(-1).seekSeconds, 0)
    await music.seek(GUILD, 4)
    assert.equal(voice.guilds.get(GUILD).plays.at(-1).seekSeconds, 4)
    await assert.rejects(() => music.seek(GUILD, 50), /outside the track/)
    const skipped = await music.nudge(GUILD, 30)
    assert.match(skipped.message, /Skipped/)
    assert.equal(music.snapshot(GUILD).current.title, 'B')
    await music.play(GUILD, channel, [track({ kind: 'radio', title: 'FM', durationMs: null, url: 'https://radio.example.com/live' })], 'now')
    const plays = voice.guilds.get(GUILD).plays.length
    await assert.rejects(() => music.seek(GUILD, 3), /live stream/)
    await assert.rejects(() => music.nudge(GUILD, 5), /live stream/)
    assert.equal(voice.guilds.get(GUILD).plays.length, plays)
    music.destroy()
  })

  test('loop song restarts, loop queue rotates, shuffle uses the injected random', async () => {
    const { music, voice } = musicKit({ random: () => 0 })
    const channel = voiceChannel()
    await music.play(GUILD, channel, [
      track({ title: 'A', url: 'https://cdn.example.com/a.mp3' }),
      track({ title: 'B', url: 'https://cdn.example.com/b.mp3' }),
      track({ title: 'C', url: 'https://cdn.example.com/c.mp3' }),
      track({ title: 'D', url: 'https://cdn.example.com/d.mp3' }),
    ])
    music.setLoopMode(GUILD, 'song')
    const before = voice.guilds.get(GUILD).plays.length
    voice.emitIdle(GUILD)
    await flush()
    assert.equal(music.snapshot(GUILD).current.title, 'A')
    assert.deepEqual(music.snapshot(GUILD).tracks.map((item) => item.title), ['B', 'C', 'D'])
    assert.equal(voice.guilds.get(GUILD).plays.length, before + 1)
    music.setLoopMode(GUILD, 'queue')
    voice.emitIdle(GUILD)
    await flush()
    assert.equal(music.snapshot(GUILD).current.title, 'B')
    assert.equal(music.snapshot(GUILD).tracks.at(-1).title, 'A')
    const shuffled = music.shuffle(GUILD)
    assert.equal(shuffled.message, 'Shuffle is on.')
    assert.deepEqual(music.snapshot(GUILD).tracks.map((item) => item.title), ['D', 'A', 'C'])
    assert.equal(music.shuffle(GUILD).message, 'Shuffle is off.')
    assert.deepEqual(music.snapshot(GUILD).tracks.map((item) => item.title), ['D', 'A', 'C'])
    music.destroy()
  })

  test('an idle event during stream setup does not skip the track', async () => {
    const voice = createFakeVoice()
    let started = false
    const { music } = musicKit({
      voice,
      sources: {
        async stream() {
          if (!started) {
            started = true
            voice.emitIdle(GUILD)
          }
          return STREAM
        },
        async related() { return [] },
      },
    })
    await music.play(GUILD, voiceChannel(), [
      track({ title: 'A', url: 'https://cdn.example.com/a.mp3' }),
      track({ title: 'B', url: 'https://cdn.example.com/b.mp3' }),
    ])
    assert.equal(music.snapshot(GUILD).current.title, 'A')
    assert.equal(voice.guilds.get(GUILD).plays.length, 1)
    music.destroy()
  })

  test('autoplay adds one unseen SoundCloud track and then stops', async () => {
    let calls = 0
    const voice = createFakeVoice()
    const sessions = (await import('../src/sessions.js')).memorySessions()
    const { configStore, musicKit: build } = await import('./harness.js')
    const store = configStore()
    store.config.autoplay = true
    const { music } = build({
      voice,
      sessions,
      store,
      sources: {
        async stream() { return STREAM },
        async related() {
          calls += 1
          if (calls === 1) {
            return [
              track({ kind: 'soundcloud', title: 'First', url: 'https://soundcloud.com/a/first', soundcloudId: '5' }),
              track({ kind: 'soundcloud', title: 'Next', url: 'https://soundcloud.com/a/next', soundcloudId: '9' }),
            ]
          }
          return [track({ kind: 'soundcloud', title: 'Next', url: 'https://soundcloud.com/a/next', soundcloudId: '9' })]
        },
      },
    })
    await music.play(GUILD, voiceChannel(), [track({
      kind: 'soundcloud',
      title: 'First',
      url: 'https://soundcloud.com/a/first',
      soundcloudId: '5',
    })])
    voice.emitIdle(GUILD)
    await flush()
    assert.equal(music.snapshot(GUILD).current.title, 'Next')
    assert.equal(calls, 1)
    voice.emitIdle(GUILD)
    await flush()
    assert.equal(music.snapshot(GUILD).current, null)
    assert.equal(calls, 2)
    assert.equal(voice.guilds.has(GUILD), false)
    music.destroy()
  })

  test('loop mode does not autoplay', async () => {
    let calls = 0
    const { music, voice, store } = musicKit({
      sources: {
        async stream() { return STREAM },
        async related() {
          calls += 1
          return []
        },
      },
    })
    store.config.autoplay = true
    await music.play(GUILD, voiceChannel(), [track({ kind: 'soundcloud', soundcloudId: '5', url: 'https://soundcloud.com/a/b' })])
    music.setLoopMode(GUILD, 'song')
    voice.emitIdle(GUILD)
    await flush()
    assert.equal(calls, 0)
    assert.equal(music.snapshot(GUILD).current.title, 'Song')
    music.destroy()
  })

  test('24/7 rejoin backs off, leave cancels it, and restore retries', async () => {
    const voice = createFakeVoice()
    let failures = 0
    const realJoin = voice.join.bind(voice)
    voice.join = async (channel) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('voice down')
      }
      return realJoin(channel)
    }
    const delays = []
    const { music, sessions, store } = musicKit({
      voice,
      sleep: async (ms) => { delays.push(ms) },
      maxRejoinAttempts: 6,
    })
    const channel = voiceChannel()
    await music.stay(GUILD, true, channel)
    assert.equal(store.config.guilds[GUILD].stayConnected, true)
    failures = 2
    delays.length = 0
    await music.disconnect(GUILD)
    assert.deepEqual(delays, [1000, 2000, 4000])
    assert.equal(voice.guilds.get(GUILD).channelId, channel.id)

    delays.length = 0
    failures = 5
    const pending = music.disconnect(GUILD)
    await music.leave(GUILD)
    await pending
    assert.equal(store.config.guilds[GUILD].stayConnected, false)
    assert.equal(sessions.get(GUILD).hold, true)
    assert.equal(voice.guilds.has(GUILD), false)

    store.config.guilds[GUILD] = { stayConnected: true }
    await sessions.set(GUILD, { voiceChannelId: channel.id, hold: false })
    failures = 1
    delays.length = 0
    await music.restore()
    assert.deepEqual(delays, [1000])
    assert.equal(voice.guilds.get(GUILD).channelId, channel.id)
    music.destroy()
    assert.equal(voice.guilds.has(GUILD), false)
  })

  test('sleep holds 24/7 and a missed sleep does not rejoin on restore', async () => {
    const timers = createManualTimers()
    const status = []
    const { music, voice, sessions, store } = musicKit({
      clock: timers,
      timers,
      status: { async update(_channel, title) { status.push(title ?? null) } },
    })
    await music.stay(GUILD, true, voiceChannel())
    music.sleep(GUILD, 1)
    timers.advance(60_000)
    await flush()
    assert.equal(sessions.get(GUILD).hold, true)
    assert.equal(voice.guilds.has(GUILD), false)
    assert.equal(status.at(-1), null)
    voice.emitDisconnect(GUILD)
    await flush()
    assert.equal(voice.guilds.has(GUILD), false)
    store.config.guilds[GUILD].stayConnected = true
    await sessions.set(GUILD, { voiceChannelId: VOICE, hold: false, sleepUntil: timers.now() - 1000 })
    await music.restore()
    assert.equal(sessions.get(GUILD).hold, true)
    assert.equal(voice.guilds.has(GUILD), false)
    music.destroy()
    assert.equal(timers.pending(), 0)
  })

  test('progress publishes on the 15s boundary and not before', async () => {
    const timers = createManualTimers()
    const views = []
    const { music } = musicKit({ clock: timers, timers })
    music.onView(() => views.push(timers.now()))
    await music.play(GUILD, voiceChannel(), [song()])
    const baseline = views.length
    timers.advance(PROGRESS_MS - 1)
    assert.equal(views.length, baseline)
    timers.advance(1)
    assert.equal(views.length, baseline + 1)
    music.destroy()
    assert.equal(timers.pending(), 0)
  })

  test('a status failure does not stop playback', async () => {
    const { music } = musicKit({
      status: { async update() { throw new Error('status down') } },
    })
    const result = await music.play(GUILD, voiceChannel(), [song()])
    assert.match(result.message, /Playing/)
    music.destroy()
  })

  test('connect failure rolls the queue back', async () => {
    const voice = createFakeVoice()
    voice.join = async () => { throw new Error('no route') }
    const { music } = musicKit({ voice })
    await assert.rejects(() => music.play(GUILD, voiceChannel(), [song()]), /no route/)
    assert.equal(music.snapshot(GUILD).current, null)
    assert.equal(music.snapshot(GUILD).tracks.length, 0)
    music.destroy()
  })

  test('hard queue cap is applied even if config asks for more', async () => {
    const { guildSettings } = await import('../src/settings.js')
    const { HARD_QUEUE_CAP } = await import('../src/limits.js')
    assert.equal(guildSettings({ maxQueueSize: 5000, guilds: {} }, GUILD).maxQueueSize, HARD_QUEUE_CAP)
    const { music, store } = musicKit()
    store.config.maxQueueSize = 1
    await music.play(GUILD, voiceChannel(), [song(), track({ title: 'B', url: 'https://cdn.example.com/b.mp3' })])
    assert.equal(music.snapshot(GUILD).tracks.length, 0)
    const full = await music.play(GUILD, voiceChannel(), [track({ title: 'C', url: 'https://cdn.example.com/c.mp3' })])
    assert.equal(full.ok, true)
    const blocked = await music.play(GUILD, voiceChannel(), [track({ title: 'D', url: 'https://cdn.example.com/d.mp3' })])
    assert.equal(blocked.ok, false)
    music.destroy()
  })
})

async function flush() {
  for (let step = 0; step < 20; step += 1) await Promise.resolve()
}

describe('interaction routing', () => {
  test('play defers before search and a denial does not search', async () => {
    const kit = musicKit()
    const calls = []
    const ctx = context(kit, {
      async search(query) {
        calls.push(query)
        return [track({ kind: 'soundcloud', title: 'Found', url: 'https://soundcloud.com/a/found', soundcloudId: '3' })]
      },
    })
    const channel = voiceChannel()
    const interaction = playInteraction(channel)
    let deferred = false
    const original = ctx.sources.search
    ctx.sources.search = async (query) => {
      deferred = interaction.deferred
      return original(query)
    }
    await handleInteraction(interaction, ctx)
    assert.equal(deferred, true)
    assert.equal(interaction.calls[0][0], 'deferReply')
    assert.equal(kit.music.snapshot(GUILD).current.title, 'Found')

    const denied = playInteraction(channel, { member: member({ voice: channel }) })
    kit.store.config.guilds[GUILD] = { textLock: true, textChannels: ['999999999999999999'] }
    calls.length = 0
    ctx.sources.search = async () => {
      calls.push('nope')
      return []
    }
    await handleInteraction(denied, ctx)
    assert.deepEqual(calls, [])
    assert.match(denied.calls.at(-1)[1].content, /allowed text channels/)
    kit.music.destroy()
  })
})

function context(kit, sources = {}) {
  return {
    music: kit.music,
    configStore: kit.store,
    playlists: { list: () => [], show() { throw new Error('no') }, create() {}, addTracks() {}, remove() {}, delete() {}, share() {}, importCode() {} },
    sources: {
      async search() { return [] },
      async expand(url) { return [track({ url, kind: 'soundcloud' })] },
      ...sources,
    },
    searches: (awaitSearch()),
    requestChannelEnabled: false,
  }
}

function awaitSearch() {
  return new (class {
    put(guildId, userId, tracks) {
      this.entry = { guildId, userId, tracks }
      return 'tokentoken00'
    }
    take(token, who) {
      if (!this.entry || token !== 'tokentoken00') return { error: 'missing' }
      if (this.entry.guildId !== who.guildId || this.entry.userId !== who.userId) return { error: 'owner' }
      return { tracks: this.entry.tracks }
    }
  })()
}

function playInteraction(channel, extra = {}) {
  const person = extra.member ?? member({
    permissions: [],
    voice: channel,
  })
  return createInteraction({
    commandName: 'play',
    member: person,
    guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
    options: options({ query: 'some song' }),
    ...extra,
  })
}
