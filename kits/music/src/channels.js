import { ChannelType } from 'discord.js'

export const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement]

export function isGuildMessageChannel(channel) {
  return TEXT_CHANNEL_TYPES.includes(channel?.type)
}
