import { Routes } from 'discord.js'
import { redact } from './env.js'
import { SET_VOICE_CHANNEL_STATUS } from './permissions.js'
import { safeLabel } from './queue.js'

export function voiceStatusText(title) {
  if (!title) return null
  return `Playing ${safeLabel(title, 480)}`.slice(0, 500)
}

export function createVoiceStatus(rest, { log = console } = {}) {
  const logged = new Set()
  return {
    async update(channel, title) {
      if (!channel?.id || !channel.permissionsFor) return { ok: false, reason: 'no-channel' }
      const me = channel.guild?.members?.me ?? null
      const perms = me ? channel.permissionsFor(me) : null
      if (!perms?.has(SET_VOICE_CHANNEL_STATUS)) return { ok: false, reason: 'permission' }
      const status = voiceStatusText(title)
      try {
        await rest.put(Routes.channelVoiceStatus(channel.id), { body: { status } })
        logged.delete(channel.id)
        return { ok: true }
      } catch (error) {
        if (!logged.has(channel.id)) {
          logged.add(channel.id)
          log.error(`Voice status skipped: ${redact(error?.message ?? error)}`)
        }
        return { ok: false, reason: 'request' }
      }
    },
  }
}
