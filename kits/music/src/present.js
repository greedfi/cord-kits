import { redact } from './env.js'
import { SAFE_MENTIONS } from './nowplaying.js'

export function createPresenter({ fetchChannel, sessions, log = console }) {
  const refs = new Map()
  return async function present(guildId, payload) {
    const saved = sessions.get(guildId)
    const channelId = saved?.textChannelId
    if (!channelId) return
    const channel = await fetchChannel(channelId)
    if (!channel?.send) return
    const body = { ...payload, allowedMentions: SAFE_MENTIONS }
    let message = refs.get(guildId) ?? null
    try {
      if (!message && saved.messageId && channel.messages?.fetch) {
        message = await channel.messages.fetch(saved.messageId).catch(() => null)
      }
      if (message?.edit) message = await message.edit(body)
      else message = await channel.send(body)
      refs.set(guildId, message)
      if (message?.id && message.id !== saved.messageId) {
        const write = sessions.set(guildId, { messageId: message.id, textChannelId: channelId })
        if (write?.catch) write.catch((error) => log.error(redact(error.message ?? error)))
      }
    } catch (error) {
      if (error?.status === 429 || error?.code === 429) return
      if (message && (error?.code === 10008 || error?.status === 404)) {
        refs.delete(guildId)
        const replacement = await channel.send(body).catch(() => null)
        if (replacement) refs.set(guildId, replacement)
        return
      }
      log.error(redact(error?.message ?? error))
    }
  }
}
