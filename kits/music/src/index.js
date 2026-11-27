import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDependencyReport } from '@discordjs/voice'
import { Client, Events, GatewayIntentBits } from 'discord.js'
import { createConfigStore, createLogger, loadSchema, configFilePath } from './config.js'
import { dataDir, envFlag, isDirectRun, loadEnv, redact, requireEnv } from './env.js'
import { acquireLock } from './lock.js'
import { inviteUrl } from './permissions.js'
import { createMusic } from './player.js'
import { createPlaylists, playlistPath } from './playlists.js'
import { createPresenter } from './present.js'
import { handleRequestMessage } from './request.js'
import { handleInteraction } from './dispatch.js'
import { createSearchCache } from './search-cache.js'
import { createSessionStore, sessionPath } from './sessions.js'
import { patchGuild } from './settings.js'
import {
  relatedSoundCloud,
  resolveSoundCloud,
  resolveSoundCloudStream,
  searchSoundCloud,
} from './soundcloud.js'
import { assertPublicHttpUrl } from './sources.js'
import { createVoiceStatus } from './voice-status.js'

const kitRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

export function gatewayIntents(requestChannelEnabled) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
  if (requestChannelEnabled) intents.push(GatewayIntentBits.MessageContent)
  return intents
}

export function defaultSources() {
  return {
    search(query, options = {}) {
      return searchSoundCloud(query, options)
    },
    expand(url, maxTracks) {
      return resolveSoundCloud(url, { maxTracks })
    },
    related(track) {
      if (!track?.soundcloudId) return []
      return relatedSoundCloud(track.soundcloudId)
    },
    async stream(track) {
      if (track.kind === 'soundcloud') return resolveSoundCloudStream(track.url)
      assertPublicHttpUrl(track.url)
      return track.url
    },
  }
}

export async function main() {
  loadEnv()
  const token = requireEnv('DISCORD_BOT_TOKEN')
  const requestChannelEnabled = envFlag('ENABLE_REQUEST_CHANNEL')
  const filePath = configFilePath()
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. Copy config.example.json to config.json and edit it.`)
  }
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  const lock = acquireLock(dir)
  const config = createConfigStore({
    filePath,
    schema: loadSchema(path.join(kitRoot, 'config.schema.json')),
    logger: createLogger(),
  })
  const sessions = createSessionStore(sessionPath(dir))
  const playlists = createPlaylists(playlistPath(dir))
  const client = new Client({ intents: gatewayIntents(requestChannelEnabled) })
  const music = createMusic(config, {
    sessions,
    sources: defaultSources(),
    status: createVoiceStatus(client.rest),
    setStay(guildId, enabled) {
      return patchGuild(config, guildId, { stayConnected: enabled })
    },
    resolveChannel(_guildId, channelId) {
      return client.channels.fetch(channelId)
    },
  })
  const present = createPresenter({
    sessions,
    fetchChannel: (channelId) => client.channels.fetch(channelId),
  })
  music.onView((guildId, payload) => {
    present(guildId, payload).catch((error) => console.error(redact(error?.message ?? error)))
  })
  const ctx = {
    music,
    configStore: config,
    playlists,
    sources: defaultSources(),
    searches: createSearchCache(),
    requestChannelEnabled,
  }
  client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction, ctx).catch((error) => console.error(redact(error?.message ?? error)))
  })
  if (requestChannelEnabled) {
    client.on(Events.MessageCreate, (message) => {
      handleRequestMessage(message, ctx).catch((error) => console.error(redact(error?.message ?? error)))
    })
  }
  client.once(Events.ClientReady, (ready) => {
    console.log(`Logged in as ${ready.user.tag}`)
    const clientId = process.env.CLIENT_ID?.trim()
    if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
    if (requestChannelEnabled) console.log('Song request channel is enabled (Message Content intent).')
    music.restore().catch((error) => console.error(redact(error?.message ?? error)))
  })
  try {
    console.log(generateDependencyReport())
  } catch (error) {
    console.error(`Voice dependency check failed: ${error.message}`)
  }
  const shutdown = () => {
    music.destroy()
    lock.release()
    config.close()
    client.destroy()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await client.login(token)
  return { client, config, music, lock }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    console.error(redact(error.message ?? error))
    process.exit(1)
  })
}
