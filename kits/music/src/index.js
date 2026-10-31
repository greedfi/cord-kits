import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDependencyReport } from '@discordjs/voice'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { configFilePath, createConfigStore, createLogger, loadSchema } from './config.js'
import { isDirectRun, loadEnv, redact, requireEnv } from './env.js'
import { inviteUrl } from './permissions.js'
import { createMusic } from './player.js'
import { formatQueue } from './queue.js'
import { resolveSoundCloud } from './soundcloud.js'
import { SourceError, classifySource } from './sources.js'

const kitRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function ephemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral }
  if (interaction.deferred) return interaction.editReply({ content })
  if (interaction.replied) return interaction.followUp(payload)
  return interaction.reply(payload)
}

async function actorMember(interaction) {
  if (interaction.member?.voice) return interaction.member
  return interaction.guild.members.fetch(interaction.user.id)
}

async function voiceChannelOf(interaction) {
  const member = await actorMember(interaction)
  const channel = member.voice?.channel ?? null
  if (!channel || channel.type !== ChannelType.GuildVoice) return null
  return channel
}

async function playCommand(interaction, music, configStore) {
  const query = interaction.options.getString('query')
  const file = interaction.options.getAttachment('file')
  const kind = interaction.options.getString('kind') ?? 'auto'
  if (!query && !file) {
    await ephemeral(interaction, 'Provide a URL or an audio file.')
    return
  }
  const voice = await voiceChannelOf(interaction)
  if (!voice) {
    await ephemeral(interaction, 'Join a voice channel first. Stage channels are not supported.')
    return
  }
  const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe()
  const botChannel = me.voice?.channelId
  if (botChannel && botChannel !== voice.id) {
    await ephemeral(interaction, 'I am already playing in another voice channel.')
    return
  }
  const permissions = voice.permissionsFor(me)
  if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
    await ephemeral(interaction, 'I need Connect and Speak in that voice channel.')
    return
  }
  let classified
  try {
    classified = classifySource(file ? null : query, { attachment: file, kind })
  } catch (error) {
    const message = error instanceof SourceError ? error.message : 'Could not read that source.'
    await ephemeral(interaction, message)
    return
  }
  await interaction.deferReply()
  try {
    let planned
    if (classified.kind === 'soundcloud') {
      const config = configStore.get()
      const guild = config.guilds?.[interaction.guild.id] ?? {}
      const maxTracks = guild.maxQueueSize ?? config.maxQueueSize
      planned = await resolveSoundCloud(classified.url, { maxTracks })
    } else {
      planned = [classified]
    }
    const tracks = planned.map((track) => ({
      kind: track.kind,
      title: track.title,
      url: track.url,
      requestedById: interaction.user.id,
      requestedByTag: interaction.user.tag,
    }))
    const result = await music.play(interaction.guild.id, voice, tracks)
    await interaction.editReply(result.message)
  } catch (error) {
    console.error(redact(error))
    const message = error instanceof Error ? error.message : 'Playback failed.'
    await interaction.editReply(message)
  }
}

async function onInteraction(interaction, music, configStore) {
  if (!interaction.isChatInputCommand()) return
  if (!interaction.inGuild()) {
    await ephemeral(interaction, 'This bot only works in servers.')
    return
  }
  try {
    if (interaction.commandName === 'play') {
      await playCommand(interaction, music, configStore)
      return
    }
    if (interaction.commandName === 'queue') {
      await interaction.reply(formatQueue(music.snapshot(interaction.guild.id)))
      return
    }
    const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe()
    const actor = await actorMember(interaction)
    const botChannel = me.voice?.channelId
    const userChannel = actor.voice?.channelId
    if (!botChannel) {
      await ephemeral(interaction, 'Nothing is playing.')
      return
    }
    if (userChannel !== botChannel) {
      await ephemeral(interaction, 'Join the voice channel the bot is in first.')
      return
    }
    if (interaction.commandName === 'skip') {
      const result = await music.skip(interaction.guild.id)
      await interaction.reply(result.message)
      return
    }
    if (interaction.commandName === 'stop') {
      const result = music.stop(interaction.guild.id)
      await interaction.reply(result.message)
      return
    }
    if (interaction.commandName === 'volume') {
      const level = interaction.options.getInteger('level', true)
      const result = music.setGuildVolume(interaction.guild.id, level)
      await interaction.reply(result.message)
    }
  } catch (error) {
    console.error(redact(error))
    await ephemeral(interaction, error instanceof Error ? error.message : 'Command failed.')
  }
}

export async function main() {
  loadEnv()
  const token = requireEnv('DISCORD_BOT_TOKEN')
  const filePath = configFilePath()
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. Copy config.example.json to config.json and edit it.`)
  }
  const schema = loadSchema(path.join(kitRoot, 'config.schema.json'))
  const config = createConfigStore({
    filePath,
    schema,
    logger: createLogger(),
  })
  const music = createMusic(config)
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  })
  client.on(Events.InteractionCreate, (interaction) => {
    onInteraction(interaction, music, config).catch((error) => console.error(redact(error)))
  })
  client.once(Events.ClientReady, (ready) => {
    console.log(`Logged in as ${ready.user.tag}`)
    const clientId = process.env.CLIENT_ID?.trim()
    if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
  })
  try {
    console.log(generateDependencyReport())
  } catch (error) {
    console.error(`Voice dependency check failed: ${error.message}`)
  }
  const shutdown = () => {
    music.destroy()
    config.close()
    client.destroy()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await client.login(token)
  return { client, config, music }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    console.error(redact(error.message ?? error))
    process.exit(1)
  })
}
