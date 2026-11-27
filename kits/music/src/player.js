import { pickRelated } from './autoplay.js'
import { redact } from './env.js'
import { UserError } from './errors.js'
import { tempoOf } from './filters.js'
import {
  HISTORY_CAP,
  MAX_REJOIN_ATTEMPTS,
  MAX_SEEK_MS,
  PROGRESS_MS,
  SEEN_CAP,
  backoffMs,
} from './limits.js'
import { buildPlayerMessage } from './nowplaying.js'
import { clampedPosition, formatTime, positionMs } from './progress.js'
import {
  createQueueState,
  cycleLoop,
  enqueueMany,
  insertManyFront,
  moveTrack,
  promote,
  pushPrevious,
  removeAt,
  safeLabel,
  setLoop,
  setVolume as applyVolume,
  stop as stopQueue,
  toggleShuffle,
} from './queue.js'
import { guildSettings } from './settings.js'
import { assertPublicHttpUrl } from './sources.js'
import { createDiscordVoice } from './voice.js'

function rememberSeen(queue, track) {
  const keys = []
  if (track?.url) keys.push(String(track.url))
  if (track?.soundcloudId != null) keys.push(String(track.soundcloudId))
  return { ...queue, seen: [...(queue.seen ?? []), ...keys].slice(-SEEN_CAP) }
}

export function createMusic(configStore, deps = {}) {
  const voice = deps.voice ?? createDiscordVoice()
  const sessions = deps.sessions ?? { get() { return null }, all() { return {} }, set() {}, delete() {} }
  const sources = deps.sources ?? {
    async stream(track) { return track.streamUrl || track.url },
    async related() { return [] },
  }
  const status = deps.status ?? { async update() { return { ok: false, reason: 'unconfigured' } } }
  const clock = deps.clock ?? Date
  const timers = deps.timers ?? globalThis
  const random = deps.random ?? Math.random
  const resolveChannel = deps.resolveChannel ?? (async () => null)
  const maxRejoinAttempts = deps.maxRejoinAttempts ?? MAX_REJOIN_ATTEMPTS
  const queues = new Map()
  const runtimes = new Map()
  const channels = new Map()
  const listeners = new Set()
  const waiters = new Set()

  function readSettings(guildId) {
    return guildSettings(configStore.get(), guildId)
  }

  function runtime(guildId) {
    if (!runtimes.has(guildId)) {
      runtimes.set(guildId, {
        token: 0,
        expectedIdleToken: -1,
        generation: 0,
        suppress: false,
        rejoining: false,
        progress: null,
        sleep: null,
      })
    }
    return runtimes.get(guildId)
  }

  function queueFor(guildId) {
    if (!queues.has(guildId)) {
      const settings = readSettings(guildId)
      const state = createQueueState(settings.defaultVolume)
      state.filter = settings.filter
      queues.set(guildId, state)
    }
    return queues.get(guildId)
  }

  function remember(guildId, patch) {
    const result = sessions.set?.(guildId, patch)
    if (result && typeof result.catch === 'function') {
      result.catch((error) => console.error(redact(error.message ?? error)))
    }
  }

  function publish(guildId) {
    const payload = buildPlayerMessage(viewOf(guildId))
    for (const listener of listeners) {
      try {
        listener(guildId, payload)
      } catch (error) {
        console.error(redact(error.message ?? error))
      }
    }
  }

  function viewOf(guildId) {
    const queue = queueFor(guildId)
    const current = queue.current
    return {
      current: Boolean(current),
      title: current?.title || current?.url || '',
      positionMs: current ? livePosition(queue) : 0,
      durationMs: current?.durationMs ?? null,
      paused: Boolean(queue.paused),
      volume: queue.volume,
      loop: queue.loop,
      shuffle: Boolean(queue.shuffle),
      waiting: queue.tracks.length,
      filter: queue.filter,
      requestedBy: current?.requestedByTag ?? null,
      artworkUrl: current?.artworkUrl ?? null,
    }
  }

  function livePosition(queue) {
    return clampedPosition(positionMs({
      originMs: queue.positionMs ?? 0,
      startedAt: queue.startedAt,
      now: clock.now(),
      paused: queue.paused,
      tempo: tempoOf(queue.filter),
    }), queue.current?.durationMs ?? null)
  }

  function delayMs(ms) {
    if (deps.sleep) return deps.sleep(ms).then(() => true)
    return new Promise((resolve) => {
      const id = timers.setTimeout(() => {
        waiters.delete(finish)
        resolve(true)
      }, ms)
      const finish = () => {
        timers.clearTimeout(id)
        waiters.delete(finish)
        resolve(false)
      }
      waiters.add(finish)
    })
  }

  function cancelDelays() {
    for (const finish of [...waiters]) finish()
  }

  function clearProgress(rt) {
    if (rt.progress) timers.clearInterval(rt.progress)
    rt.progress = null
  }

  function ensureProgress(guildId) {
    const rt = runtime(guildId)
    clearProgress(rt)
    rt.progress = timers.setInterval(() => {
      const queue = queues.get(guildId)
      if (!queue?.current || queue.paused) return
      publish(guildId)
    }, PROGRESS_MS)
  }

  async function updateStatus(guildId, title) {
    const channel = channels.get(guildId)
    if (!channel) return
    try {
      await status.update(channel, title)
    } catch (error) {
      console.error(redact(error.message ?? error))
    }
  }

  function stillWanted(guildId, generation) {
    const rt = runtime(guildId)
    if (rt.generation !== generation) return false
    const saved = sessions.get(guildId)
    if (!saved?.voiceChannelId || saved.hold) return false
    if (!readSettings(guildId).stayConnected) return false
    return true
  }

  async function rejoinLoop(guildId, generation, immediate) {
    for (let attempt = 0; attempt < maxRejoinAttempts; attempt += 1) {
      if (!stillWanted(guildId, generation)) return false
      const delay = immediate && attempt === 0 ? 0 : backoffMs(immediate ? Math.max(0, attempt - 1) : attempt)
      if (delay > 0) {
        const woke = await delayMs(delay)
        if (!woke || !stillWanted(guildId, generation)) return false
      }
      try {
        const saved = sessions.get(guildId)
        const channel = await resolveChannel(guildId, saved.voiceChannelId)
        if (!channel) throw new UserError('Voice channel is gone.')
        runtime(guildId).suppress = false
        await voice.join(channel)
        channels.set(guildId, channel)
        return true
      } catch (error) {
        console.error(`Rejoin failed in ${guildId}: ${redact(error.message ?? error)}`)
      }
    }
    return false
  }

  function beginRejoin(guildId, immediate) {
    const rt = runtime(guildId)
    if (rt.rejoining && rt.rejoin) return rt.rejoin
    const generation = rt.generation
    rt.rejoining = true
    rt.rejoin = rejoinLoop(guildId, generation, immediate).finally(() => {
      rt.rejoining = false
      rt.rejoin = null
    })
    return rt.rejoin
  }

  async function startCurrent(guildId) {
    const rt = runtime(guildId)
    const track = queues.get(guildId)?.current
    if (!track) return false
    const token = ++rt.token
    rt.expectedIdleToken = -1
    let streamUrl
    try {
      streamUrl = await sources.stream(track)
      assertPublicHttpUrl(streamUrl)
    } catch (error) {
      console.error(`Stream failed: ${redact(error.message ?? error)}`)
      return false
    }
    if (rt.token !== token) return false
    const latest = queues.get(guildId)
    try {
      await voice.play(guildId, {
        url: streamUrl,
        seekSeconds: (latest.positionMs || 0) / 1000,
        filter: latest.filter || 'off',
        volume: latest.volume,
      })
    } catch (error) {
      console.error(`Playback failed: ${redact(error.message ?? error)}`)
      return false
    }
    if (rt.token !== token) return false
    rt.expectedIdleToken = token
    const playing = queues.get(guildId)
    queues.set(guildId, rememberSeen({
      ...playing,
      startedAt: clock.now(),
      paused: false,
      stale: false,
    }, track))
    publish(guildId)
    ensureProgress(guildId)
    await updateStatus(guildId, playing.current?.title || playing.current?.url)
    return true
  }

  async function beginIfNeeded(guildId) {
    let state = queues.get(guildId)
    if (!state?.current) {
      const next = promote(state)
      queues.set(guildId, { ...next.state, positionMs: 0, paused: false, startedAt: null, stale: false })
      state = queues.get(guildId)
    }
    if (!state.current) return false
    return startCurrent(guildId)
  }

  async function finishEmpty(guildId) {
    const queue = queueFor(guildId)
    queues.set(guildId, {
      ...queue,
      current: null,
      tracks: [],
      paused: false,
      positionMs: 0,
      startedAt: null,
      stale: false,
    })
    clearProgress(runtime(guildId))
    publish(guildId)
    if (!readSettings(guildId).stayConnected) {
      await updateStatus(guildId, null)
      const rt = runtime(guildId)
      rt.suppress = true
      voice.destroy(guildId)
      channels.delete(guildId)
    } else {
      await updateStatus(guildId, null)
    }
  }

  async function maybeAutoplay(guildId, ended) {
    if (!ended || ended.kind !== 'soundcloud' || !readSettings(guildId).autoplay) return false
    let related = []
    try {
      related = await sources.related(ended)
    } catch (error) {
      console.error(`Autoplay lookup failed: ${redact(error.message ?? error)}`)
      return false
    }
    const queue = queueFor(guildId)
    const pick = pickRelated(related, {
      current: null,
      waiting: queue.tracks,
      previous: queue.previous,
      seen: queue.seen ?? [],
    })
    if (!pick) return false
    const track = {
      ...pick,
      requestedById: ended.requestedById ?? null,
      requestedByTag: 'autoplay',
    }
    const queued = enqueueMany(queue, [track], readSettings(guildId).maxQueueSize)
    if (queued.accepted.length === 0) return false
    const next = promote(queued.state)
    queues.set(guildId, { ...next.state, positionMs: 0, paused: false, startedAt: null, stale: false })
    return startCurrent(guildId)
  }

  async function advance(guildId, depth = 0) {
    if (depth > 5) return finishEmpty(guildId)
    let queue = queueFor(guildId)
    if (queue.loop === 'song' && queue.current) {
      queues.set(guildId, { ...queue, positionMs: 0, paused: false, startedAt: null, stale: false })
      if (await startCurrent(guildId)) return
      queue = queueFor(guildId)
      queues.set(guildId, { ...queue, current: null })
      queue = queueFor(guildId)
    }
    if (queue.loop === 'queue' && queue.current) {
      const rotated = {
        ...queue,
        previous: pushPrevious(queue, queue.current, HISTORY_CAP),
        tracks: [...queue.tracks, queue.current],
        current: null,
      }
      const next = promote(rotated)
      queues.set(guildId, { ...next.state, positionMs: 0, paused: false, startedAt: null, stale: false })
      if (next.track && await startCurrent(guildId)) return
      return advance(guildId, depth + 1)
    }
    const ended = queue.current
    const next = promote({
      ...queue,
      previous: pushPrevious(queue, queue.current, HISTORY_CAP),
      current: null,
    })
    queues.set(guildId, { ...next.state, positionMs: 0, paused: false, startedAt: null, stale: false })
    if (next.track) {
      if (await startCurrent(guildId)) return
      return advance(guildId, depth + 1)
    }
    if (queue.loop === 'off' && await maybeAutoplay(guildId, ended)) return
    return finishEmpty(guildId)
  }

  function onIdle(guildId) {
    const rt = runtimes.get(guildId)
    if (!rt || rt.token !== rt.expectedIdleToken) return
    rt.token += 1
    rt.expectedIdleToken = -1
    advance(guildId).catch((error) => console.error(redact(error.message ?? error)))
  }

  function onDisconnect(guildId) {
    const rt = runtime(guildId)
    if (rt.suppress) return null
    const saved = sessions.get(guildId)
    if (saved?.hold || !saved?.voiceChannelId) return null
    if (!readSettings(guildId).stayConnected) return null
    return beginRejoin(guildId, false)
  }

  voice.setHandlers({ onIdle, onDisconnect })

  async function ensureJoined(guildId, channel) {
    const rt = runtime(guildId)
    rt.suppress = false
    await voice.join(channel)
    channels.set(guildId, channel)
    remember(guildId, { voiceChannelId: channel.id })
  }

  function clearSleep(guildId) {
    const rt = runtime(guildId)
    if (rt.sleep) timers.clearTimeout(rt.sleep)
    rt.sleep = null
    remember(guildId, { hold: false, sleepUntil: null })
  }

  function requireCurrent(guildId) {
    const queue = queueFor(guildId)
    if (!queue.current) throw new UserError('Nothing is playing.')
    return queue
  }

  function armSleep(guildId, ms) {
    const rt = runtime(guildId)
    if (rt.sleep) timers.clearTimeout(rt.sleep)
    remember(guildId, { sleepUntil: clock.now() + ms, hold: false })
    rt.sleep = timers.setTimeout(() => {
      rt.sleep = null
      remember(guildId, { hold: true, sleepUntil: null })
      rt.suppress = true
      rt.generation += 1
      const queue = queues.get(guildId)
      if (queue) queues.set(guildId, stopQueue(queue))
      clearProgress(rt)
      voice.stop(guildId)
      updateStatus(guildId, null).catch((error) => console.error(redact(error.message ?? error))).finally(() => {
        voice.destroy(guildId)
        channels.delete(guildId)
        publish(guildId)
      })
    }, ms)
  }

  return {
    snapshot(guildId) {
      return structuredClone(queueFor(guildId))
    },
    view(guildId) {
      return buildPlayerMessage(viewOf(guildId))
    },
    onView(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh(guildId) {
      publish(guildId)
      return buildPlayerMessage(viewOf(guildId))
    },
    bindText(guildId, channelId) {
      remember(guildId, { textChannelId: channelId })
    },
    async play(guildId, channel, tracks, placement = 'end') {
      clearSleep(guildId)
      runtime(guildId).suppress = false
      const settings = readSettings(guildId)
      const existing = queueFor(guildId)
      const wasIdle = !existing.current
      let result
      if (placement === 'now') {
        const track = tracks[0]
        if (!track) return { ok: false, message: 'Nothing to play.' }
        result = {
          accepted: [track],
          rejected: Math.max(0, tracks.length - 1),
          state: {
            ...existing,
            previous: existing.current ? pushPrevious(existing, existing.current, HISTORY_CAP) : (existing.previous ?? []),
            current: { ...track },
            positionMs: 0,
            paused: false,
            startedAt: null,
            stale: false,
          },
        }
      } else if (placement === 'next') {
        result = insertManyFront(existing, tracks, settings.maxQueueSize)
      } else {
        result = enqueueMany(existing, tracks, settings.maxQueueSize)
      }
      if (!result.accepted.length) return { ok: false, message: `The queue is full (${settings.maxQueueSize}).` }
      queues.set(guildId, result.state)
      try {
        await ensureJoined(guildId, channel)
        if (placement === 'now' || wasIdle) {
          const ok = await beginIfNeeded(guildId)
          if (!ok) throw new UserError("Couldn't play that track. Check ffmpeg and the URL.")
        }
      } catch (error) {
        if (wasIdle || placement === 'now') queues.set(guildId, existing)
        throw error
      }
      if (!(placement === 'now' || wasIdle)) publish(guildId)
      const label = safeLabel(result.accepted[0].title || result.accepted[0].url)
      const waiting = queues.get(guildId).tracks.length
      let message = (placement === 'now' || wasIdle) ? `Playing ${label}.` : `Queued ${label}.`
      if (waiting > 0) message += ` ${waiting} waiting.`
      if (result.rejected > 0) message += ` ${result.rejected} did not fit.`
      return { ok: true, message }
    },
    async skip(guildId) {
      const queue = queueFor(guildId)
      if (!queue.current && queue.tracks.length === 0) return { ok: false, message: 'Nothing is playing.' }
      const rt = runtime(guildId)
      rt.token += 1
      rt.expectedIdleToken = -1
      voice.stop(guildId)
      const next = promote({
        ...queue,
        previous: pushPrevious(queue, queue.current, HISTORY_CAP),
        current: null,
      })
      queues.set(guildId, { ...next.state, positionMs: 0, paused: false, startedAt: null, stale: false })
      if (!next.track) {
        if (queue.loop === 'off' && await maybeAutoplay(guildId, queue.current)) {
          return { ok: true, message: 'Skipped.' }
        }
        await finishEmpty(guildId)
        return { ok: true, message: 'Skipped. The queue is empty.' }
      }
      if (!await startCurrent(guildId)) await advance(guildId, 1)
      const now = queues.get(guildId)?.current
      return {
        ok: true,
        message: now ? `Skipped. Now playing ${safeLabel(now.title || now.url)}.` : 'Skipped. The queue is empty.',
      }
    },
    async back(guildId) {
      const queue = queueFor(guildId)
      if (!queue.current && (queue.previous ?? []).length === 0) throw new UserError('Nothing to go back to.')
      if ((queue.previous ?? []).length === 0) return this.replay(guildId)
      const track = queue.previous[queue.previous.length - 1]
      const previous = queue.previous.slice(0, -1)
      let tracks = queue.current ? [queue.current, ...queue.tracks] : queue.tracks.slice()
      const cap = readSettings(guildId).maxQueueSize
      if (tracks.length > cap) tracks = tracks.slice(0, cap)
      const rt = runtime(guildId)
      rt.token += 1
      rt.expectedIdleToken = -1
      voice.stop(guildId)
      queues.set(guildId, {
        ...queue,
        previous,
        current: track,
        tracks,
        positionMs: 0,
        paused: false,
        startedAt: null,
        stale: false,
      })
      if (!await startCurrent(guildId)) throw new UserError("Couldn't play that track. Check ffmpeg and the URL.")
      return { ok: true, message: `Back to ${safeLabel(track.title || track.url)}.` }
    },
    async replay(guildId) {
      const queue = requireCurrent(guildId)
      const rt = runtime(guildId)
      rt.token += 1
      rt.expectedIdleToken = -1
      queues.set(guildId, { ...queue, positionMs: 0, paused: false, stale: false })
      if (!await startCurrent(guildId)) throw new UserError("Couldn't play that track. Check ffmpeg and the URL.")
      return { ok: true, message: 'Restarted the current track.' }
    },
    async pause(guildId) {
      const queue = requireCurrent(guildId)
      if (queue.paused) throw new UserError('Playback is already paused.')
      const position = livePosition(queue)
      voice.pause(guildId)
      queues.set(guildId, { ...queue, paused: true, positionMs: position, startedAt: null })
      publish(guildId)
      return { ok: true, message: 'Paused.' }
    },
    async resume(guildId) {
      const queue = requireCurrent(guildId)
      if (!queue.paused) throw new UserError('Playback is not paused.')
      if (queue.stale) {
        queues.set(guildId, { ...queue, paused: false, stale: false })
        if (!await startCurrent(guildId)) throw new UserError("Couldn't play that track. Check ffmpeg and the URL.")
      } else {
        voice.resume(guildId)
        queues.set(guildId, { ...queue, paused: false, startedAt: clock.now() })
        publish(guildId)
        ensureProgress(guildId)
      }
      return { ok: true, message: 'Resumed.' }
    },
    async stop(guildId) {
      const queue = queueFor(guildId)
      if (!queue.current && queue.tracks.length === 0) return { ok: false, message: 'Nothing is playing.' }
      const rt = runtime(guildId)
      rt.token += 1
      rt.expectedIdleToken = -1
      queues.set(guildId, stopQueue(queue))
      voice.stop(guildId)
      clearProgress(rt)
      await updateStatus(guildId, null)
      if (!readSettings(guildId).stayConnected) {
        rt.suppress = true
        voice.destroy(guildId)
        channels.delete(guildId)
      }
      publish(guildId)
      return { ok: true, message: 'Stopped playback and cleared the queue.' }
    },
    async leave(guildId) {
      const rt = runtime(guildId)
      rt.suppress = true
      rt.generation += 1
      if (rt.sleep) timers.clearTimeout(rt.sleep)
      rt.sleep = null
      clearProgress(rt)
      const queue = queues.get(guildId)
      if (queue) queues.set(guildId, stopQueue(queue))
      voice.stop(guildId)
      await updateStatus(guildId, null)
      voice.destroy(guildId)
      channels.delete(guildId)
      remember(guildId, { hold: true, voiceChannelId: null, sleepUntil: null })
      if (deps.setStay) {
        try {
          await deps.setStay(guildId, false)
        } catch (error) {
          console.error(redact(error.message ?? error))
        }
      }
      publish(guildId)
      return { ok: true, message: 'Left the voice channel.' }
    },
    async join(guildId, channel) {
      clearSleep(guildId)
      await ensureJoined(guildId, channel)
      return { ok: true, message: 'Joined the voice channel.' }
    },
    setGuildVolume(guildId, level) {
      const next = applyVolume(queueFor(guildId), level)
      queues.set(guildId, next)
      voice.setVolume?.(guildId, level)
      publish(guildId)
      return { ok: true, message: `Volume set to ${level}%.` }
    },
    async seek(guildId, seconds) {
      const queue = requireCurrent(guildId)
      if (queue.current.kind === 'radio') throw new UserError("Can't seek a live stream.")
      if (!Number.isFinite(seconds) || seconds < 0) throw new UserError('That position is outside the track.')
      const target = Math.floor(seconds * 1000)
      if (target > MAX_SEEK_MS) throw new UserError('That position is outside the track.')
      if (queue.current.durationMs != null && target > queue.current.durationMs) {
        throw new UserError('That position is outside the track.')
      }
      return seekTo(guildId, queue, target)
    },
    async nudge(guildId, deltaSeconds) {
      const queue = requireCurrent(guildId)
      if (queue.current.kind === 'radio') throw new UserError("Can't seek a live stream.")
      const target = livePosition(queue) + (deltaSeconds * 1000)
      if (queue.current.durationMs != null && target >= queue.current.durationMs) return this.skip(guildId)
      return seekTo(guildId, queue, Math.max(0, target))
    },
    async setFilter(guildId, filter) {
      if (!['off', 'bassboost', 'nightcore', '8d'].includes(filter)) throw new UserError('Unknown filter.')
      const queue = queueFor(guildId)
      const position = queue.current ? livePosition(queue) : 0
      queues.set(guildId, {
        ...queue,
        filter,
        positionMs: position,
        startedAt: queue.paused ? null : queue.startedAt,
        stale: Boolean(queue.paused && queue.current),
      })
      if (queue.current && !queue.paused) {
        queues.set(guildId, { ...queues.get(guildId), positionMs: position })
        if (!await startCurrent(guildId)) throw new UserError("Couldn't play that track. Check ffmpeg and the URL.")
      } else {
        publish(guildId)
      }
      return { ok: true, message: `Filter set to ${filter}.` }
    },
    setLoopMode(guildId, mode) {
      queues.set(guildId, setLoop(queueFor(guildId), mode))
      publish(guildId)
      return { ok: true, message: `Loop is ${mode}.` }
    },
    cycleLoopMode(guildId) {
      const next = cycleLoop(queueFor(guildId))
      queues.set(guildId, next)
      publish(guildId)
      return { ok: true, message: `Loop is ${next.loop}.` }
    },
    shuffle(guildId) {
      const next = toggleShuffle(queueFor(guildId), random)
      queues.set(guildId, next)
      publish(guildId)
      return { ok: true, message: next.shuffle ? 'Shuffle is on.' : 'Shuffle is off.' }
    },
    move(guildId, from, to) {
      const result = moveTrack(queueFor(guildId), from, to)
      if (!result.ok) throw new UserError('That position is not in the queue.')
      queues.set(guildId, result.state)
      publish(guildId)
      return { ok: true, message: `Moved track ${from} to ${to}.` }
    },
    remove(guildId, index) {
      const result = removeAt(queueFor(guildId), index)
      if (!result.ok) throw new UserError('That track number is not in the queue.')
      queues.set(guildId, result.state)
      publish(guildId)
      return { ok: true, message: `Removed ${safeLabel(result.removed.title || result.removed.url)}.` }
    },
    clear(guildId) {
      const queue = queueFor(guildId)
      if (queue.tracks.length === 0 && !queue.current) return { ok: false, message: 'The queue is empty.' }
      const removed = queue.tracks.length
      queues.set(guildId, { ...queue, tracks: [] })
      publish(guildId)
      return { ok: true, message: `Cleared ${removed} waiting track(s).` }
    },
    sleep(guildId, minutes) {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
        throw new UserError('Sleep timer must be from 1 to 180 minutes.')
      }
      if (!channels.has(guildId)) throw new UserError('Nothing is playing.')
      armSleep(guildId, minutes * 60_000)
      return { ok: true, message: `Leaving in ${minutes} minute(s).` }
    },
    async stay(guildId, enabled, channel) {
      if (deps.setStay) await deps.setStay(guildId, enabled)
      if (!enabled) {
        remember(guildId, { hold: true })
        return { ok: true, message: '24/7 mode is off.' }
      }
      if (!channel) throw new UserError('Join a voice channel first.')
      clearSleep(guildId)
      runtime(guildId).suppress = false
      await ensureJoined(guildId, channel)
      remember(guildId, { voiceChannelId: channel.id, hold: false })
      return { ok: true, message: '24/7 mode is on. I will rejoin this voice channel after a disconnect or restart.' }
    },
    async restore() {
      const saved = sessions.all()
      for (const [guildId, entry] of Object.entries(saved)) {
        if (!readSettings(guildId).stayConnected || entry.hold || !entry.voiceChannelId) continue
        if (entry.sleepUntil && entry.sleepUntil > clock.now()) {
          armSleep(guildId, entry.sleepUntil - clock.now())
          continue
        }
        if (entry.sleepUntil && entry.sleepUntil <= clock.now()) {
          remember(guildId, { hold: true, sleepUntil: null })
          continue
        }
        const rt = runtime(guildId)
        rt.suppress = false
        await rejoinLoop(guildId, rt.generation, true)
      }
    },
    disconnect(guildId) {
      return onDisconnect(guildId)
    },
    destroy() {
      for (const rt of runtimes.values()) {
        rt.generation += 1
        rt.suppress = true
        clearProgress(rt)
        if (rt.sleep) timers.clearTimeout(rt.sleep)
        rt.sleep = null
      }
      cancelDelays()
      voice.destroyAll()
      listeners.clear()
    },
  }

  async function seekTo(guildId, queue, target) {
    const rt = runtime(guildId)
    queues.set(guildId, {
      ...queues.get(guildId),
      positionMs: target,
      startedAt: queue.paused ? null : clock.now(),
      stale: queue.paused,
    })
    if (!queue.paused) {
      rt.token += 1
      rt.expectedIdleToken = -1
      if (!await startCurrent(guildId)) throw new UserError("Couldn't play that track. Check ffmpeg and the URL.")
    } else {
      publish(guildId)
    }
    return { ok: true, message: `Moved to ${formatTime(target)}.` }
  }
}
