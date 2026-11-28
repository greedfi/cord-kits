import { ChannelType, PermissionFlagsBits, Routes } from 'discord.js'
import { safeLabel } from './queue.js'

export function voiceStatusRequest(channel, text) {
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    return { ok: false, reason: 'unsupported' }
  }
  const member = channel.guild?.members?.me
  const permissions = member && typeof channel.permissionsFor === 'function'
    ? channel.permissionsFor(member)
    : null
  if (!permissions?.has?.(PermissionFlagsBits.SetVoiceChannelStatus)) {
    return { ok: false, reason: 'missing_permission' }
  }
  const status = text == null || String(text).trim() === '' ? null : safeLabel(text, 500)
  return {
    ok: true,
    route: Routes.channelVoiceStatus(channel.id),
    body: { status },
  }
}

export async function pushVoiceStatus({ rest, channel, text }) {
  const request = voiceStatusRequest(channel, text)
  if (!request.ok) return request
  await rest.put(request.route, { body: request.body })
  return { ok: true }
}
