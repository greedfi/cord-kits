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
import { redact } from './env.js'
import { UserError } from './errors.js'
import { ffmpegArgs } from './filters.js'

function killChild(child) {
  if (!child || child.killed) return
  child.kill('SIGKILL')
}

export function createDiscordVoice(deps = {}) {
  const join = deps.joinVoiceChannel ?? joinVoiceChannel
  const makePlayer = deps.createAudioPlayer ?? createAudioPlayer
  const makeResource = deps.createAudioResource ?? createAudioResource
  const waitFor = deps.entersState ?? entersState
  const spawnProcess = deps.spawn ?? spawn
  const sessions = new Map()
  const handlers = {
    onIdle() {},
    onDisconnect() {},
  }

  function sessionFor(guildId) {
    let session = sessions.get(guildId)
    if (session) return session
    const player = makePlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    session = { player, connection: null, child: null, ignoreIdle: false, channel: null }
    player.on('error', (error) => {
      console.error(`Audio player error in ${guildId}: ${redact(error.message)}`)
    })
    player.on(AudioPlayerStatus.Idle, () => {
      if (session.ignoreIdle) return
      handlers.onIdle(guildId)
    })
    sessions.set(guildId, session)
    return session
  }

  return {
    setHandlers(next) {
      if (next.onIdle) handlers.onIdle = next.onIdle
      if (next.onDisconnect) handlers.onDisconnect = next.onDisconnect
    },
    async join(channel) {
      const guildId = channel.guild.id
      const session = sessionFor(guildId)
      const alive = session.connection
        && session.connection.state.status !== VoiceConnectionStatus.Destroyed
        && session.connection.joinConfig.channelId === channel.id
      if (alive) {
        session.connection.subscribe(session.player)
        session.channel = channel
        return session
      }
      if (session.connection) session.connection.destroy()
      const connection = join({
        channelId: channel.id,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
      })
      session.connection = connection
      session.channel = channel
      connection.subscribe(session.player)
      connection.on('stateChange', (_oldState, nextState) => {
        if (nextState.status === VoiceConnectionStatus.Destroyed) {
          if (session.connection === connection) session.connection = null
          return
        }
        if (nextState.status !== VoiceConnectionStatus.Disconnected) return
        Promise.race([
          waitFor(connection, VoiceConnectionStatus.Signalling, 5_000),
          waitFor(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]).catch(() => {
          if (session.connection !== connection) return
          handlers.onDisconnect(guildId)
        })
      })
      try {
        await waitFor(connection, VoiceConnectionStatus.Ready, 15_000)
      } catch {
        connection.destroy()
        session.connection = null
        throw new UserError('Could not connect to the voice channel.')
      }
      return session
    },
    async play(guildId, spec) {
      const session = sessions.get(guildId)
      if (!session?.connection) throw new UserError('Could not connect to the voice channel.')
      const args = ffmpegArgs(spec)
      session.ignoreIdle = true
      session.player.stop(true)
      killChild(session.child)
      const child = spawnProcess(process.env.FFMPEG_PATH?.trim() || 'ffmpeg', args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      session.child = child
      session.resource = null
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-500)
      })
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new UserError('ffmpeg did not start.')), 5_000)
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(new UserError(`ffmpeg is not available (${error.code || 'error'}).`))
          })
          child.once('spawn', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      } catch (error) {
        session.ignoreIdle = false
        killChild(child)
        throw error
      }
      let resource
      try {
        resource = makeResource(child.stdout, { inputType: StreamType.Raw, inlineVolume: true })
        resource.volume?.setVolume((spec.volume ?? 100) / 100)
      } catch (error) {
        session.ignoreIdle = false
        killChild(child)
        throw error
      }
      resource.playStream?.on?.('error', (error) => {
        console.error(`ffmpeg stream error: ${redact(stderr || error.message)}`)
      })
      session.ignoreIdle = false
      session.resource = resource
      try {
        session.player.play(resource)
      } catch (error) {
        killChild(child)
        session.resource = null
        throw error
      }
      return resource
    },
    setVolume(guildId, level) {
      sessions.get(guildId)?.resource?.volume?.setVolume(level / 100)
    },
    pause(guildId) {
      sessions.get(guildId)?.player.pause()
    },
    resume(guildId) {
      sessions.get(guildId)?.player.unpause()
    },
    stop(guildId) {
      const session = sessions.get(guildId)
      if (!session) return
      session.ignoreIdle = true
      killChild(session.child)
      session.child = null
      session.player.stop(true)
      session.ignoreIdle = false
    },
    destroy(guildId) {
      const session = sessions.get(guildId)
      if (!session) return
      session.ignoreIdle = true
      killChild(session.child)
      session.child = null
      session.player.stop(true)
      session.connection?.destroy()
      session.connection = null
      sessions.delete(guildId)
    },
    destroyAll() {
      for (const guildId of [...sessions.keys()]) this.destroy(guildId)
    },
    channel(guildId) {
      return sessions.get(guildId)?.channel ?? null
    },
  }
}
