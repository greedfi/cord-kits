import { spawn } from 'node:child_process'
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice'
import { ChannelType } from 'discord.js'
import { voiceAllowed } from './access.js'
import { redact } from './env.js'
import { ffmpegArguments, filterRate } from './filters.js'
import {
  back as backTrack,
  clearWaiting,
  createQueueState,
  enqueueMany,
  finishCurrent,
  insertFront,
  moveTrack,
  playedMs,
  removeAt,
  replaceCurrent,
  safeLabel,
  seekTo,
  setVolume,
  shuffleTracks,
  stop as stopQueue,
} from './queue.js'
import { rejoinDelayMs } from './sessions.js'
import { guildSettings, waitingLimit } from './settings.js'
import { chooseAutoplayTrack, relatedSoundCloudTracks, resolveSoundCloudStream } from './soundcloud.js'
import { resolveSafeStreamUrl } from './sources.js'

const defaultVoice = {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
}

function logError(error) {
  const text = error instanceof Error ? error.stack ?? error.message : error
  console.error(redact(text))
}

function defaultSchedule(fn, ms) {
  const id = setTimeout(() => {
    Promise.resolve(fn()).catch(logError)
  }, ms)
  return { cancel() { clearTimeout(id) } }
}

const SEEK_MESSAGES = {
  idle: 'Nothing is playing.',
  unseekable: 'That track cannot be seeked.',
  bad_position: 'That is not a valid position.',
  past_end: 'That position is past the end of the track.',
}

export function createMusic(configStore, deps = {}) {
  const voice = deps.voice ?? defaultVoice
  const schedule = deps.schedule ?? defaultSchedule
  const now = deps.now ?? (() => Date.now())
  const spawnImpl = deps.spawn ?? spawn
  const stateStore = deps.stateStore ?? null
  const queues = new Map()
  const sessions = new Map()
  const tails = new Map()
  const statusFailures = new Set()
  let closed = false

  function settings(guildId) {
    return guildSettings(configStore.get(), guildId)
  }

  function limit(guildId) {
    return waitingLimit(settings(guildId))
  }

  function queueFor(guildId) {
    if (!queues.has(guildId)) {
      const prefs = settings(guildId)
      const state = createQueueState(prefs.defaultVolume)
      state.filter = prefs.filter
      queues.set(guildId, state)
    }
    return queues.get(guildId)
  }

  function lock(guildId, fn) {
    const prev = tails.get(guildId) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(() => (closed ? null : fn()))
    tails.set(guildId, run.then(() => {}, () => {}))
    return run
  }

  function sessionFor(guildId) {
    if (sessions.has(guildId)) return sessions.get(guildId)
    const player = voice.createAudioPlayer({
      behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause },
    })
    const session = {
      player,
      connection: null,
      channel: null,
      ffmpeg: null,
      token: 0,
      expectedIdleToken: 0,
      intentional: false,
      rejoinTimer: null,
      sleepTimer: null,
      rejoinAttempt: 0,
    }
    player.on('error', (error) => {
      console.error(redact(`Audio player error in ${guildId}: ${error.message}`))
    })
    player.on(voice.AudioPlayerStatus.Idle, () => {
      if (session.token !== session.expectedIdleToken) return
      const queue = queues.get(guildId)
      const exit = session.ffmpegExit
      const elapsed = queue?.startedAt == null ? 0 : now() - queue.startedAt
      const badExit = exit
        && exit.token === session.expectedIdleToken
        && (exit.code !== 0 || elapsed < 500)
      if (badExit && queue?.current && !queue.current.failed) {
        queues.set(guildId, { ...queue, current: { ...queue.current, failed: true } })
      }
      session.token += 1
      queueMicrotask(() => {
        lock(guildId, () => advance(guildId, { natural: true })).catch((error) => {
          console.error(redact(`Queue advance failed in ${guildId}: ${error.message}`))
        })
      })
    })
    sessions.set(guildId, session)
    return session
  }

  function killFfmpeg(session) {
    const child = session?.ffmpeg
    session.resource = null
    if (!child) return
    session.ffmpeg = null
    child.killedByUs = true
    child.kill('SIGKILL')
  }

  function remember(guildId, channelId) {
    if (!stateStore) return
    if (!settings(guildId).stayConnected) {
      stateStore.put(guildId, { channelId: null, sleepUntil: null })
      return
    }
    stateStore.put(guildId, { channelId, sleepUntil: null })
  }

  function forget(guildId) {
    stateStore?.put(guildId, { channelId: null, sleepUntil: null })
  }

  function sleeping(guildId) {
    const until = stateStore?.get(guildId)?.sleepUntil
    return Boolean(until && until > now())
  }

  async function showStatus(channel, text) {
    if (!deps.setVoiceStatus || !channel) return
    try {
      await deps.setVoiceStatus(channel, text)
      statusFailures.delete(channel.id)
    } catch (error) {
      if (statusFailures.has(channel.id)) return
      statusFailures.add(channel.id)
      console.error(redact(`Voice status update failed: ${error.message}`))
    }
  }

  function onConnection(guildId, connection, next) {
    const session = sessions.get(guildId)
    if (!session) return
    if (next.status === voice.VoiceConnectionStatus.Destroyed) {
      if (session.connection === connection) session.connection = null
      return
    }
    if (next.status !== voice.VoiceConnectionStatus.Disconnected) return
    if (session.intentional || closed) return
    if (settings(guildId).stayConnected && !sleeping(guildId)) {
      scheduleRejoin(guildId)
      return
    }
    Promise.race([
      voice.entersState(connection, voice.VoiceConnectionStatus.Signalling, 5_000),
      voice.entersState(connection, voice.VoiceConnectionStatus.Connecting, 5_000),
    ]).catch(() => {
      if (session.connection !== connection || session.intentional) return
      session.intentional = true
      try {
        connection.destroy()
      } catch (error) {
        console.error(redact(error.message))
      }
    })
  }

  function scheduleRejoin(guildId) {
    const session = sessionFor(guildId)
    if (session.rejoinTimer || session.intentional || closed) return
    const delay = rejoinDelayMs(session.rejoinAttempt)
    session.rejoinAttempt += 1
    session.rejoinTimer = schedule(() => {
      session.rejoinTimer = null
      return lock(guildId, async () => {
        if (closed || session.intentional) return
        if (!settings(guildId).stayConnected || sleeping(guildId)) return
        const channelId = stateStore?.get(guildId)?.channelId ?? session.channel?.id
        if (!channelId || !deps.fetchChannel) return
        const channel = await deps.fetchChannel(guildId, channelId)
        if (!channel) {
          forget(guildId)
          return
        }
        await connect(channel)
      }).catch((error) => {
        console.error(redact(`Rejoin failed in ${guildId}: ${error.message}`))
        scheduleRejoin(guildId)
      })
    }, delay)
  }

  async function connect(channel) {
    const guildId = channel.guild.id
    if (channel.type === ChannelType.GuildStageVoice) {
      throw new Error('Stage channels are not supported.')
    }
    if (!voiceAllowed(settings(guildId), channel.id)) {
      throw new Error('That voice channel is not allowed.')
    }
    const session = sessionFor(guildId)
    session.intentional = false
    const status = session.connection?.state?.status
    const reusable = status === voice.VoiceConnectionStatus.Ready
      || status === voice.VoiceConnectionStatus.Connecting
      || status === voice.VoiceConnectionStatus.Signalling
    if (reusable && session.connection.joinConfig.channelId === channel.id) {
      session.connection.subscribe(session.player)
      session.channel = channel
      if (settings(guildId).stayConnected) remember(guildId, channel.id)
      return session.connection
    }
    if (
      status === voice.VoiceConnectionStatus.Disconnected
      && session.connection.joinConfig.channelId === channel.id
      && typeof session.connection.rejoin === 'function'
    ) {
      const rejoined = session.connection.rejoin({ channelId: channel.id, selfDeaf: true })
      if (rejoined) {
        session.channel = channel
        try {
          await voice.entersState(session.connection, voice.VoiceConnectionStatus.Ready, 15_000)
        } catch {
          throw new Error('Could not connect to the voice channel.')
        }
        session.connection.subscribe(session.player)
        session.rejoinAttempt = 0
        if (settings(guildId).stayConnected) remember(guildId, channel.id)
        if (!queueFor(guildId).paused && session.player.state?.status === voice.AudioPlayerStatus.Paused) {
          session.player.unpause()
        }
        return session.connection
      }
    }
    if (session.connection) {
      session.intentional = true
      try {
        session.connection.destroy()
      } catch (error) {
        console.error(redact(error.message))
      }
      session.intentional = false
      session.connection = null
    }
    const connection = voice.joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    })
    session.connection = connection
    session.channel = channel
    connection.on('stateChange', (_oldState, nextState) => onConnection(guildId, connection, nextState))
    try {
      await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15_000)
    } catch {
      try {
        connection.destroy()
      } catch (error) {
        console.error(redact(error.message))
      }
      if (session.connection === connection) session.connection = null
      throw new Error('Could not connect to the voice channel.')
    }
    connection.subscribe(session.player)
    session.rejoinAttempt = 0
    if (settings(guildId).stayConnected) remember(guildId, channel.id)
    if (!queueFor(guildId).paused && session.player.state?.status === voice.AudioPlayerStatus.Paused) {
      session.player.unpause()
    }
    return connection
  }

  function markFailed(guildId) {
    const queue = queues.get(guildId)
    if (!queue?.current || queue.current.failed) return
    queues.set(guildId, { ...queue, current: { ...queue.current, failed: true } })
  }

  async function streamUrl(track) {
    let raw
    if (deps.resolveStream) raw = await deps.resolveStream(track)
    else if (track.kind === 'soundcloud') raw = await resolveSoundCloudStream(track.url)
    else raw = track.url
    return resolveSafeStreamUrl(raw, {
      fetchImpl: deps.fetchImpl ?? fetch,
      lookup: deps.lookup,
    })
  }

  async function startCurrent(guildId) {
    const session = sessionFor(guildId)
    const track = queues.get(guildId)?.current
    if (!track) return
    const token = session.token + 1
    session.token = token
    killFfmpeg(session)
    const url = await streamUrl(track)
    if (session.token !== token || closed) return
    const queue = queues.get(guildId)
    const seekSeconds = queue.offsetMs > 0 && track.kind !== 'radio' ? queue.offsetMs / 1000 : 0
    const args = ffmpegArguments(url, { seekSeconds, filter: queue.filter })
    const executable = process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
    const child = spawnImpl(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderrChunks = []
    child.stderr?.on?.('data', (chunk) => {
      stderrChunks.push(chunk)
      if (stderrChunks.length > 20) stderrChunks.shift()
    })
    child.stderr?.on?.('error', () => {})
    child.stdout?.on?.('error', () => {})
    child.once?.('error', (error) => {
      session.ffmpegError = error
      if (session.ffmpeg === child) {
        session.ffmpeg = null
        session.resource = null
      }
      markFailed(guildId)
    })
    child.once?.('exit', (code, signal) => {
      if (child.killedByUs || signal === 'SIGKILL') return
      session.ffmpegExit = { code: code ?? 0, token }
    })
    if (session.token !== token || closed) {
      child.killedByUs = true
      child.kill('SIGKILL')
      return
    }
    session.ffmpeg = child
    session.ffmpegExit = null
    session.ffmpegError = null
    await new Promise((resolve) => process.nextTick(resolve))
    if (session.token !== token || closed) {
      child.killedByUs = true
      child.kill('SIGKILL')
      return
    }
    if (session.ffmpegError) {
      const failure = new Error('ffmpeg failed to start. Install ffmpeg or set FFMPEG_PATH.')
      session.startupError = failure
      throw failure
    }
    if (session.ffmpegExit?.token === token) {
      markFailed(guildId)
      const detail = Buffer.concat(stderrChunks.map((chunk) => Buffer.from(chunk))).toString().trim()
      const suffix = detail ? ` ${detail.slice(-180)}` : ''
      const failure = new Error(`ffmpeg exited before playback started.${suffix}`)
      session.startupError = failure
      throw failure
    }
    const resource = voice.createAudioResource(child.stdout, {
      inputType: voice.StreamType.Raw,
      inlineVolume: true,
      metadata: { title: track.title },
    })
    resource.volume?.setVolume((queue.volume ?? 100) / 100)
    session.resource = resource
    queues.set(guildId, { ...queues.get(guildId), startedAt: now(), paused: false })
    session.expectedIdleToken = token
    session.player.play(resource)
    await showStatus(session.channel, track.title)
  }

  async function maybeAutoplay(guildId) {
    const prefs = settings(guildId)
    if (!prefs.autoplay) return false
    const queue = queues.get(guildId)
    const previous = queue?.history?.[queue.history.length - 1]
    if (!previous || previous.kind !== 'soundcloud') return false
    let related = []
    try {
      related = deps.relatedTracks
        ? await deps.relatedTracks(previous)
        : await relatedSoundCloudTracks(previous)
    } catch (error) {
      console.error(redact(`Autoplay lookup failed: ${error.message}`))
      return false
    }
    const pick = chooseAutoplayTrack(related, {
      current: previous,
      queued: queue.tracks,
      recent: queue.history.slice(0, -1),
    })
    if (!pick) return false
    const result = enqueueMany(queue, [{
      ...pick,
      requestedById: previous.requestedById ?? null,
      requestedByTag: previous.requestedByTag ?? 'autoplay',
    }], limit(guildId))
    if (result.accepted.length === 0) return false
    queues.set(guildId, result.state)
    return true
  }

  async function settleEmpty(guildId) {
    const session = sessions.get(guildId)
    await showStatus(session?.channel, null)
    if (settings(guildId).stayConnected && !sleeping(guildId)) return
    disconnect(guildId, { clear: true })
  }

  async function advance(guildId, { natural }) {
    let naturalStep = natural
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (closed) return false
      const step = finishCurrent(queues.get(guildId) ?? queueFor(guildId), { natural: naturalStep })
      naturalStep = false
      queues.set(guildId, step.state)
      if (!step.track && step.autoplay) {
        const added = await maybeAutoplay(guildId)
        if (!added) break
        continue
      }
      if (!step.track) break
      try {
        await startCurrent(guildId)
        return true
      } catch (error) {
        console.error(redact(`Playback failed: ${error.message}`))
        markFailed(guildId)
        const session = sessions.get(guildId)
        if (session && !session.startupError) session.startupError = error
      }
    }
    const leftover = queues.get(guildId)
    if (leftover?.current) {
      queues.set(guildId, {
        ...leftover,
        history: [...leftover.history, leftover.current].slice(-25),
        current: null,
        offsetMs: 0,
        startedAt: null,
        paused: false,
      })
    }
    await settleEmpty(guildId)
    return false
  }

  function disconnect(guildId, { clear }) {
    const session = sessions.get(guildId)
    if (!session) {
      if (clear) forget(guildId)
      return
    }
    session.intentional = true
    if (session.rejoinTimer) {
      session.rejoinTimer.cancel()
      session.rejoinTimer = null
    }
    if (session.sleepTimer) {
      session.sleepTimer.cancel()
      session.sleepTimer = null
    }
    killFfmpeg(session)
    session.token += 1
    try {
      session.player.stop(true)
    } catch (error) {
      console.error(redact(error.message))
    }
    if (session.connection) {
      try {
        session.connection.destroy()
      } catch (error) {
        console.error(redact(error.message))
      }
      session.connection = null
    }
    const channel = session.channel
    session.channel = null
    if (clear) forget(guildId)
    return channel
  }

  function describe(result, placement, idle) {
    const label = safeLabel(result.accepted[0].title || result.accepted[0].url)
    const playing = placement === 'skip' || idle
    let message = playing ? `Playing **${label}**.` : `Queued **${label}**.`
    if (result.rejected > 0) message += ` ${result.rejected} did not fit.`
    return message
  }

  async function play(guildId, channel, tracks, placement = 'end') {
    const existing = queues.get(guildId) ?? queueFor(guildId)
    const idle = existing.current == null
    let result
    if (placement === 'skip' && existing.current) result = replaceCurrent(existing, tracks, limit(guildId))
    else if (placement === 'top' && existing.current) result = insertFront(existing, tracks, limit(guildId))
    else result = enqueueMany(existing, tracks, limit(guildId))
    if (result.accepted.length === 0) {
      return { ok: false, message: `The queue is full (${limit(guildId)}).` }
    }
    queues.set(guildId, result.state)
    try {
      await connect(channel)
    } catch (error) {
      queues.set(guildId, existing)
      throw error
    }
    if (placement === 'skip' && !idle) {
      const session = sessionFor(guildId)
      session.token += 1
      session.player.stop(true)
      await startOrAdvance(guildId)
    } else if (idle) {
      const started = await advance(guildId, { natural: true })
      if (!started) {
        const failure = sessionFor(guildId).startupError
        queues.set(guildId, existing)
        throw failure ?? new Error('Could not start playback. Check ffmpeg and the URL.')
      }
    }
    const waiting = queues.get(guildId)?.tracks.length ?? 0
    let message = describe(result, placement, idle)
    if (waiting > 0) message += ` ${waiting} waiting.`
    return { ok: true, message }
  }

  async function startOrAdvance(guildId) {
    try {
      await startCurrent(guildId)
    } catch (error) {
      console.error(redact(`Playback failed: ${error.message}`))
      markFailed(guildId)
      await advance(guildId, { natural: false })
    }
  }

  async function restart(guildId) {
    const session = sessionFor(guildId)
    session.token += 1
    try {
      session.player.stop(true)
    } catch (error) {
      console.error(redact(error.message))
    }
    await startOrAdvance(guildId)
  }

  return {
    snapshot(guildId) {
      const prefs = settings(guildId)
      const queue = queues.get(guildId) ?? {
        ...createQueueState(prefs.defaultVolume),
        filter: prefs.filter,
      }
      const session = sessions.get(guildId)
      const connected = Boolean(
        session?.connection
        && session.connection.state.status !== voice.VoiceConnectionStatus.Destroyed,
      )
      return {
        ...queue,
        positionMs: playedMs(queue, now(), filterRate(queue.filter)),
        connected,
        channelId: session?.channel?.id ?? null,
      }
    },
    settled(guildId) {
      return tails.get(guildId) ?? Promise.resolve()
    },
    play: (guildId, channel, tracks, placement) => lock(guildId, () => play(guildId, channel, tracks, placement)),
    async skip(guildId) {
      return lock(guildId, async () => {
        const existing = queues.get(guildId)
        if (!existing?.current && !(existing?.tracks.length)) {
          return { ok: false, message: 'Nothing is playing.' }
        }
        const step = finishCurrent(existing, { natural: false })
        queues.set(guildId, step.state)
        const session = sessionFor(guildId)
        session.token += 1
        session.player.stop(true)
        if (!step.track) {
          await settleEmpty(guildId)
          return { ok: true, message: 'Skipped. The queue is empty.' }
        }
        await startOrAdvance(guildId)
        const playing = queues.get(guildId)?.current
        if (!playing) return { ok: true, message: 'Skipped. The queue is empty.' }
        return { ok: true, message: `Skipped. Now playing **${safeLabel(playing.title || playing.url)}**.` }
      })
    },
    async back(guildId) {
      return lock(guildId, async () => {
        const result = backTrack(queueFor(guildId), limit(guildId))
        if (!result.ok) {
          const message = result.error === 'queue_full'
            ? 'The queue is full.'
            : 'Nothing to go back to.'
          return { ok: false, message }
        }
        queues.set(guildId, result.state)
        await restart(guildId)
        return { ok: true, message: `Back to **${safeLabel(result.track.title || result.track.url)}**.` }
      })
    },
    async replay(guildId) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        if (!queue.current) return { ok: false, message: 'Nothing is playing.' }
        queues.set(guildId, { ...queue, offsetMs: 0, paused: false, startedAt: null })
        await restart(guildId)
        return { ok: true, message: 'Started the current track again.' }
      })
    },
    pause(guildId) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        if (!queue.current) return { ok: false, message: 'Nothing is playing.' }
        if (queue.paused) return { ok: false, message: 'Playback is already paused.' }
        const position = playedMs(queue, now(), filterRate(queue.filter))
        queues.set(guildId, { ...queue, paused: true, offsetMs: position, startedAt: null })
        sessionFor(guildId).player.pause(true)
        return { ok: true, message: 'Paused.' }
      })
    },
    resume(guildId) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        if (!queue.current) return { ok: false, message: 'Nothing is playing.' }
        if (!queue.paused) return { ok: false, message: 'Playback is not paused.' }
        queues.set(guildId, { ...queue, paused: false, startedAt: now() })
        sessionFor(guildId).player.unpause()
        return { ok: true, message: 'Resumed.' }
      })
    },
    stop(guildId) {
      return lock(guildId, async () => halt(guildId, 'Stopped playback and cleared the queue.'))
    },
    leave(guildId) {
      return lock(guildId, async () => halt(guildId, 'Left the voice channel.'))
    },
    join(guildId, channel) {
      return lock(guildId, async () => {
        await connect(channel)
        return { ok: true, message: 'Joined the voice channel.' }
      })
    },
    loop(guildId, mode) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        queues.set(guildId, { ...queue, loop: mode })
        return { ok: true, message: `Loop is ${mode}.` }
      })
    },
    shuffle(guildId, random) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        if (queue.tracks.length < 2) return { ok: false, message: 'Nothing is waiting to shuffle.' }
        queues.set(guildId, { ...queue, tracks: shuffleTracks(queue.tracks, random) })
        return { ok: true, message: 'Shuffled the queue.' }
      })
    },
    move(guildId, from, to) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        const result = moveTrack(queue.tracks, from, to)
        if (!result.ok) return { ok: false, message: 'That position is outside the queue.' }
        queues.set(guildId, { ...queue, tracks: result.tracks })
        return { ok: true, message: from === to ? 'That track is already there.' : `Moved ${from} to ${to}.` }
      })
    },
    remove(guildId, index) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        const result = removeAt(queue.tracks, index)
        if (!result.ok) return { ok: false, message: 'That position is outside the queue.' }
        queues.set(guildId, { ...queue, tracks: result.tracks })
        return { ok: true, message: `Removed **${safeLabel(result.removed.title || result.removed.url)}**.` }
      })
    },
    clear(guildId) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        if (queue.tracks.length === 0) return { ok: false, message: 'The queue is already empty.' }
        queues.set(guildId, clearWaiting(queue))
        return { ok: true, message: 'Cleared the waiting queue.' }
      })
    },
    seek(guildId, positionMs) {
      return lock(guildId, () => seek(guildId, positionMs))
    },
    nudge(guildId, deltaMs) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        const position = playedMs(queue, now(), filterRate(queue.filter)) + deltaMs
        return seek(guildId, Math.max(0, position))
      })
    },
    volume(guildId, level) {
      return lock(guildId, async () => {
        const state = setVolume(queueFor(guildId), level)
        queues.set(guildId, state)
        sessions.get(guildId)?.resource?.volume?.setVolume(level / 100)
        return { ok: true, message: `Volume set to ${level}%.` }
      })
    },
    setFilter(guildId, filter) {
      return lock(guildId, async () => {
        const queue = queueFor(guildId)
        const position = playedMs(queue, now(), filterRate(queue.filter))
        queues.set(guildId, {
          ...queue,
          filter,
          offsetMs: queue.current ? position : 0,
          startedAt: null,
          paused: false,
        })
        if (queue.current) await restart(guildId)
        const label = filter === '8d' ? '8D' : filter
        return { ok: true, message: `Filter set to ${label}.` }
      })
    },
    sleep(guildId, minutes) {
      return lock(guildId, async () => {
        const session = sessions.get(guildId)
        if (!session?.connection) return { ok: false, message: 'I am not in a voice channel.' }
        if (session.sleepTimer) {
          session.sleepTimer.cancel()
          session.sleepTimer = null
        }
        if (minutes === 0) {
          stateStore?.put(guildId, { sleepUntil: null })
          return { ok: true, message: 'Sleep timer cancelled.' }
        }
        const until = now() + minutes * 60_000
        stateStore?.put(guildId, { sleepUntil: until, channelId: session.channel?.id ?? null })
        const timer = schedule(() => {
          if (session.sleepTimer !== timer) return null
          session.sleepTimer = null
          return lock(guildId, async () => {
            const channel = disconnect(guildId, { clear: true })
            queues.set(guildId, stopQueue(queueFor(guildId)))
            await showStatus(channel, null)
          }).catch(logError)
        }, minutes * 60_000)
        session.sleepTimer = timer
        return { ok: true, message: `Leaving in ${minutes} minute${minutes === 1 ? '' : 's'}.` }
      })
    },
    noteStay(guildId, enabled) {
      return lock(guildId, async () => {
        const session = sessions.get(guildId)
        if (!enabled) {
          session?.rejoinTimer?.cancel()
          if (session) session.rejoinTimer = null
          stateStore?.put(guildId, { channelId: null, sleepUntil: null })
          return
        }
        if (session?.channel) remember(guildId, session.channel.id)
      })
    },
    restore() {
      return lock('__restore__', () => restore())
    },
    destroy() {
      closed = true
      for (const session of sessions.values()) {
        session.intentional = true
        session.rejoinTimer?.cancel()
        session.sleepTimer?.cancel()
        killFfmpeg(session)
        session.token += 1
        try {
          session.player.stop(true)
        } catch (error) {
          console.error(redact(error.message))
        }
        if (session.connection) {
          try {
            session.connection.destroy()
          } catch (error) {
            console.error(redact(error.message))
          }
        }
        showStatus(session.channel, null).catch(logError)
      }
      sessions.clear()
    },
  }

  async function seek(guildId, positionMs) {
    const result = seekTo(queueFor(guildId), positionMs)
    if (!result.ok) return { ok: false, message: SEEK_MESSAGES[result.error] ?? 'Could not seek.' }
    queues.set(guildId, result.state)
    await restart(guildId)
    return { ok: true, message: 'Seeked.' }
  }

  async function halt(guildId, message) {
    const queue = queues.get(guildId)
    const session = sessions.get(guildId)
    const busy = Boolean(queue?.current || queue?.tracks.length || session?.connection)
    if (!busy) return { ok: false, message: 'Nothing is playing.' }
    if (session?.sleepTimer) {
      session.sleepTimer.cancel()
      session.sleepTimer = null
    }
    queues.set(guildId, stopQueue(queue ?? queueFor(guildId)))
    const channel = disconnect(guildId, { clear: true })
    await showStatus(channel, null)
    return { ok: true, message }
  }

  async function restore() {
    if (!stateStore || !deps.fetchChannel) return
    for (const [guildId, row] of Object.entries(stateStore.all())) {
      if (!settings(guildId).stayConnected) continue
      if (row.sleepUntil && row.sleepUntil > now()) {
        const session = sessionFor(guildId)
        const delay = row.sleepUntil - now()
        session.sleepTimer = schedule(() => {
          session.sleepTimer = null
          forget(guildId)
        }, delay)
        continue
      }
      if (row.sleepUntil || !row.channelId) {
        if (row.sleepUntil) forget(guildId)
        continue
      }
      try {
        const channel = await deps.fetchChannel(guildId, row.channelId)
        if (!channel) {
          forget(guildId)
          continue
        }
        await connect(channel)
      } catch (error) {
        console.error(redact(`Restore failed in ${guildId}: ${error.message}`))
        scheduleRejoin(guildId)
      }
    }
  }
}
