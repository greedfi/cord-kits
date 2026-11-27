import { ChannelType } from 'discord.js'
import { commandDenial } from './access.js'
import { redact } from './env.js'
import { publicMessage } from './errors.js'
import { UserError } from './errors.js'
import { REQUEST_TEXT_MAX } from './limits.js'
import { SAFE_MENTIONS } from './nowplaying.js'
import { guildSettings } from './settings.js'
import { interpretQuery } from './sources.js'

export function inspectRequest(message, { enabled, settings }) {
  if (!enabled) return { action: 'ignore', reason: 'disabled' }
  if (!message?.guildId || message.author?.bot || message.webhookId) return { action: 'ignore', reason: 'bot' }
  if (!settings?.requestChannelId) return { action: 'ignore', reason: 'unset' }
  if (message.channelId !== settings.requestChannelId) return { action: 'ignore', reason: 'channel' }
  const text = String(message.content ?? '').trim()
  if (text.length < 2) return { action: 'ignore', reason: 'short' }
  if (text.length > REQUEST_TEXT_MAX) {
    return { action: 'deny', reason: 'Send a shorter title or a single URL (200 characters max).' }
  }
  const found = text.match(/https?:\/\/\S+/)
  const query = found ? found[0].replace(/[>),.\]]+$/g, '') : text
  return { action: 'play', query }
}

function decorate(track, user) {
  return {
    kind: track.kind,
    title: track.title || track.url,
    url: track.url,
    durationMs: track.durationMs ?? null,
    soundcloudId: track.soundcloudId ?? null,
    artworkUrl: track.artworkUrl ?? null,
    requestedById: user.id,
    requestedByTag: user.username || user.tag || user.id,
  }
}

async function notify(message, text) {
  if (!message.channel?.send) return
  const sent = await message.channel.send({
    content: String(text).slice(0, 300),
    allowedMentions: SAFE_MENTIONS,
  }).catch(() => null)
  if (!sent?.delete) return
  const timer = setTimeout(() => {
    sent.delete().catch(() => {})
  }, 8_000)
  timer.unref?.()
}

export async function handleRequestMessage(message, ctx) {
  const settings = message.guildId ? guildSettings(ctx.configStore.get(), message.guildId) : null
  const plan = inspectRequest(message, { enabled: Boolean(ctx.requestChannelEnabled), settings })
  if (plan.action === 'ignore') return plan
  const voice = message.member?.voice?.channel ?? null
  const denial = commandDenial({
    command: 'play',
    member: message.member,
    channelId: message.channelId,
    voiceChannelId: voice?.id ?? null,
    settings,
    configuring: false,
  })
  const inVoice = voice && voice.type === ChannelType.GuildVoice
  if (plan.action === 'deny' || denial || !inVoice) {
    const reason = denial || plan.reason || 'Join a voice channel first. Stage channels are not supported.'
    await notify(message, reason)
    if (settings?.requestAutoDelete) await message.delete?.().catch(() => {})
    return { action: 'deny', reason }
  }
  try {
    const interpreted = interpretQuery(plan.query)
    let planned
    if (interpreted.mode === 'search') {
      const found = await ctx.sources.search(interpreted.query, { limit: 1 })
      if (!found?.length) throw new UserError('No SoundCloud track matched that name.')
      planned = found.slice(0, 1)
    } else if (interpreted.classified.kind === 'soundcloud') {
      planned = await ctx.sources.expand(interpreted.classified.url, settings.maxQueueSize)
    } else {
      planned = [interpreted.classified]
    }
    ctx.music.bindText(message.guildId, settings.requestChannelId)
    await ctx.music.play(
      message.guildId,
      voice,
      planned.map((track) => decorate(track, message.author)),
    )
    if (settings.requestAutoDelete) await message.delete?.().catch(() => {})
    return { action: 'play' }
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : error))
    await notify(message, publicMessage(error))
    return { action: 'deny', reason: 'failed' }
  }
}
