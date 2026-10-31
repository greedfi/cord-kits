import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice'
import {
  enqueueMany,
  promote,
  safeLabel,
  setVolume,
  stop as stopQueue,
} from './queue.js'
import { assertPublicHttpUrl } from './sources.js'
import { resolveSoundCloudStream } from './soundcloud.js'

async function streamUrlFor(track) {
  if (track.kind === 'soundcloud') {
    const streamUrl = await resolveSoundCloudStream(track.url)
    assertPublicHttpUrl(streamUrl)
    return streamUrl
  }
  assertPublicHttpUrl(track.url)
  return track.url
}

export function createMusic(configStore) {
  const queues = new Map()
  const sessions = new Map()

  function limits(guildId) {
    const config = configStore.get()
    const guild = config.guilds?.[guildId] ?? {}
    return {
      maxQueueSize: guild.maxQueueSize ?? config.maxQueueSize,
      defaultVolume: guild.defaultVolume ?? config.defaultVolume,
    }
  }

  function queueFor(guildId) {
    if (!queues.has(guildId)) queues.set(guildId, {
      current: null,
      tracks: [],
      volume: limits(guildId).defaultVolume,
    })
    return queues.get(guildId)
  }

  function session(guildId) {
    if (sessions.has(guildId)) return sessions.get(guildId)
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    })
    const state = {
      player,
      connection: null,
      resource: null,
      token: 0,
      expectedIdleToken: 0,
    }
    player.on('error', (error) => {
      console.error(`Audio player error in ${guildId}: ${error.message}`)
    })
    // stop() also emits Idle. The token ignores that event so skip/stop
    // do not advance the queue a second time.
    player.on(AudioPlayerStatus.Idle, () => {
      if (state.token !== state.expectedIdleToken) return
      state.token += 1
      const current = queues.get(guildId)
      if (!current) return
      queues.set(guildId, { ...current, current: null })
      playUntilStarted(guildId, { throwOnFail: false }).catch((error) => {
        console.error(`Queue advance failed in ${guildId}: ${error.message}`)
      })
    })
    sessions.set(guildId, state)
    return state
  }

  function leave(guildId) {
    const state = sessions.get(guildId)
    if (!state) return
    state.connection?.destroy()
    state.connection = null
    state.resource = null
  }

  async function connect(voiceChannel) {
    const state = session(voiceChannel.guild.id)
    const alive = state.connection
      && state.connection.state.status !== VoiceConnectionStatus.Destroyed
    if (alive && state.connection.joinConfig.channelId === voiceChannel.id) {
      state.connection.subscribe(state.player)
      return state.connection
    }
    if (state.connection) state.connection.destroy()
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    })
    state.connection = connection
    connection.on('stateChange', (_oldState, nextState) => {
      if (nextState.status === VoiceConnectionStatus.Destroyed) {
        if (state.connection === connection) state.connection = null
        return
      }
      if (nextState.status !== VoiceConnectionStatus.Disconnected) return
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        if (state.connection === connection) connection.destroy()
      })
    })
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000)
    } catch {
      connection.destroy()
      state.connection = null
      throw new Error('Could not connect to the voice channel.')
    }
    connection.subscribe(state.player)
    return connection
  }

  async function startCurrent(guildId) {
    const state = session(guildId)
    const track = queues.get(guildId)?.current
    if (!track) return
    const token = ++state.token
    const streamUrl = await streamUrlFor(track)
    if (state.token !== token) return
    const resource = createAudioResource(streamUrl, {
      inlineVolume: true,
      metadata: { url: track.url, title: track.title },
    })
    resource.volume?.setVolume((queues.get(guildId)?.volume ?? 100) / 100)
    state.resource = resource
    state.expectedIdleToken = token
    state.player.play(resource)
  }

  async function playUntilStarted(guildId, { throwOnFail }) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let state = queues.get(guildId) ?? queueFor(guildId)
      if (!state.current) {
        const promoted = promote(state)
        queues.set(guildId, promoted.state)
        state = promoted.state
      }
      if (!state.current) {
        leave(guildId)
        if (throwOnFail) throw new Error('Could not start playback. Check ffmpeg and the URL.')
        return false
      }
      try {
        await startCurrent(guildId)
        return true
      } catch (error) {
        console.error(`Playback failed for ${state.current.url}: ${error.message}`)
        queues.set(guildId, { ...queues.get(guildId), current: null })
        if (attempt === 4 && throwOnFail) {
          leave(guildId)
          throw new Error(`Couldn't play that track (${error.message}). ffmpeg needs to be on PATH.`)
        }
      }
    }
    leave(guildId)
    return false
  }

  return {
    snapshot(guildId) {
      return queueFor(guildId)
    },
    async play(guildId, voiceChannel, tracks) {
      const existing = queues.get(guildId) ?? queueFor(guildId)
      const idle = existing.current == null
      const result = enqueueMany(existing, tracks, limits(guildId).maxQueueSize)
      if (result.accepted.length === 0) {
        return { ok: false, message: `The queue is full (${limits(guildId).maxQueueSize}).` }
      }
      queues.set(guildId, result.state)
      try {
        await connect(voiceChannel)
        if (idle) await playUntilStarted(guildId, { throwOnFail: true })
      } catch (error) {
        if (idle) queues.set(guildId, existing)
        throw error
      }
      const current = queues.get(guildId)
      const playing = current.current
      const label = safeLabel(playing?.title || playing?.url || result.accepted[0].title || result.accepted[0].url)
      let message = idle && playing
        ? `Playing **${label}**.`
        : `Queued **${safeLabel(result.accepted[0].title || result.accepted[0].url)}**.`
      if (current.tracks.length > 0) message += ` ${current.tracks.length} waiting.`
      if (result.rejected > 0) message += ` ${result.rejected} did not fit.`
      return { ok: true, message }
    },
    async skip(guildId) {
      const existing = queues.get(guildId)
      if (!existing || (!existing.current && existing.tracks.length === 0)) {
        return { ok: false, message: 'Nothing is playing.' }
      }
      const state = session(guildId)
      state.token += 1
      const next = promote({ ...existing, current: null })
      queues.set(guildId, next.state)
      state.player.stop(true)
      if (!next.track) {
        leave(guildId)
        return { ok: true, message: 'Skipped. The queue is empty.' }
      }
      await startCurrent(guildId)
      return { ok: true, message: `Skipped. Now playing **${safeLabel(next.track.title || next.track.url)}**.` }
    },
    stop(guildId) {
      const existing = queues.get(guildId)
      if (!existing || (!existing.current && existing.tracks.length === 0)) {
        return { ok: false, message: 'Nothing is playing.' }
      }
      queues.set(guildId, stopQueue(existing))
      const state = sessions.get(guildId)
      if (state) {
        state.token += 1
        state.player.stop(true)
        leave(guildId)
      }
      return { ok: true, message: 'Stopped playback and cleared the queue.' }
    },
    setGuildVolume(guildId, level) {
      const state = setVolume(queueFor(guildId), level)
      queues.set(guildId, state)
      sessions.get(guildId)?.resource?.volume?.setVolume(level / 100)
      return { ok: true, message: `Volume set to ${level}%.` }
    },
    destroy() {
      for (const [guildId, state] of sessions) {
        state.token += 1
        state.player.stop(true)
        leave(guildId)
      }
      sessions.clear()
    },
  }
}
