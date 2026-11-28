import fs from 'node:fs'
import path from 'node:path'
import { ChannelType, Events } from 'discord.js'
import { dataDir, redact } from './env.js'
import { createApp } from './handlers.js'
import { editDecision, MIN_EDIT_GAP_MS, nowPlayingPayload, PROGRESS_INTERVAL_MS, SAFE_MENTIONS } from './nowplaying.js'
import { createMusic } from './player.js'
import { createPlaylistStore } from './playlists.js'
import { createStateStore } from './sessions.js'
import { pushVoiceStatus } from './voice-status.js'

function missingPanel(error) {
  return error?.code === 10008 || error?.code === 10003 || error?.code === 50001
}

function panelKey(payload) {
  const embed = payload.embeds?.[0]?.toJSON?.() ?? payload.embeds?.[0] ?? {}
  const rows = (payload.components ?? []).map((row) => row.toJSON?.() ?? row)
  return JSON.stringify({ embed, rows })
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

function defaultInterval(fn, ms) {
  const id = setInterval(() => {
    Promise.resolve(fn()).catch(logError)
  }, ms)
  return { cancel() { clearInterval(id) } }
}

export function createPanels({ store, editMessage, sendMessage }) {
  return {
    get(guildId) {
      const row = store.get(guildId)
      if (!row?.panelMessageId || !row.panelChannelId) return null
      return { channelId: row.panelChannelId, messageId: row.panelMessageId }
    },
    ids() {
      return Object.keys(store.all()).filter((guildId) => this.get(guildId))
    },
    async save(guildId, target) {
      store.put(guildId, { panelChannelId: target.channelId, panelMessageId: target.messageId })
    },
    async edit(target, body) {
      await editMessage(target, { ...body, allowedMentions: SAFE_MENTIONS })
    },
    forget(guildId) {
      store.put(guildId, { panelChannelId: null, panelMessageId: null })
    },
    async show(guildId, channel, body) {
      const current = this.get(guildId)
      if (current?.channelId === channel.id) {
        try {
          await this.edit(current, body)
          return current
        } catch (error) {
          if (!missingPanel(error)) throw error
        }
      }
      const sent = await sendMessage(channel, { ...body, allowedMentions: SAFE_MENTIONS })
      const target = { channelId: channel.id, messageId: sent.id }
      await this.save(guildId, target)
      return target
    },
  }
}

export function createProgressLoop({
  music,
  panels,
  now = () => Date.now(),
  schedule = defaultSchedule,
  interval = defaultInterval,
}) {
  const last = new Map()
  const sent = new Map()
  const trailing = new Map()
  let timer = null

  async function push(guildId, reason) {
    const target = panels.get(guildId)
    if (!target) return
    const clock = now()
    const snapshot = music.snapshot(guildId)
    if (reason === 'progress' && !snapshot.current) return
    const decision = editDecision({ now: clock, lastEditAt: last.get(guildId) ?? 0, reason })
    if (decision === 'wait') return
    if (decision === 'trail') {
      if (trailing.has(guildId)) return
      trailing.set(guildId, schedule(() => {
        trailing.delete(guildId)
        push(guildId, 'progress').catch(logError)
      }, MIN_EDIT_GAP_MS))
      return
    }
    const body = nowPlayingPayload(snapshot, clock)
    const key = panelKey(body)
    if (key === sent.get(guildId)) return
    sent.set(guildId, key)
    last.set(guildId, clock)
    try {
      await panels.edit(target, body)
    } catch (error) {
      if (!missingPanel(error)) throw error
      panels.forget?.(guildId)
      sent.delete(guildId)
    }
  }

  return {
    push,
    mark(guildId) {
      last.set(guildId, now())
    },
    start() {
      timer ??= interval(() => {
        for (const guildId of panels.ids()) push(guildId, 'progress').catch(logError)
      }, PROGRESS_INTERVAL_MS)
    },
    stop() {
      timer?.cancel()
      timer = null
      for (const handle of trailing.values()) handle.cancel()
      trailing.clear()
    },
  }
}

async function fetchVoiceChannel(client, guildId, channelId) {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId)
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId)
  if (!channel || channel.type !== ChannelType.GuildVoice) return null
  return channel
}

export function createRuntime({
  config,
  client,
  requestChannel,
  dataPath = dataDir(),
  fsImpl = fs,
  now,
  schedule,
  resolveTracks,
  music: musicOverride,
}) {
  fsImpl.mkdirSync(dataPath, { recursive: true })
  const store = createStateStore(path.join(dataPath, 'state.json'), fsImpl)
  const playlists = createPlaylistStore({
    file: path.join(dataPath, 'playlists.json'),
    fsImpl,
    now,
  })
  let progress
  const music = musicOverride ?? createMusic(config, {
    stateStore: store,
    now,
    schedule,
    fetchChannel: (guildId, channelId) => fetchVoiceChannel(client, guildId, channelId),
    setVoiceStatus: (channel, text) => pushVoiceStatus({ rest: client.rest, channel, text }),
    onPlaybackChange: (guildId) => progress?.push(guildId, 'action'),
  })
  const panels = createPanels({
    store,
    editMessage: async (target, body) => {
      const channel = await client.channels.fetch(target.channelId)
      await channel.messages.edit(target.messageId, body)
    },
    sendMessage: (channel, body) => channel.send(body),
  })
  progress = createProgressLoop({ music, panels, now, schedule })
  const app = createApp({
    config,
    music,
    playlists,
    panels,
    progress,
    requestChannel,
    now,
    resolveTracks,
  })
  progress.start()
  return {
    music,
    playlists,
    store,
    panels,
    progress,
    app,
    requestChannel: Boolean(requestChannel),
    restore: () => music.restore(),
    shutdown() {
      progress.stop()
      music.destroy()
    },
  }
}

export function attachClient(client, runtime) {
  client.on(Events.InteractionCreate, (interaction) => {
    runtime.app.handleInteraction(interaction).catch(logError)
  })
  if (runtime.requestChannel) {
    client.on(Events.MessageCreate, (message) => {
      runtime.app.handleMessage(message).catch(logError)
    })
  }
}
