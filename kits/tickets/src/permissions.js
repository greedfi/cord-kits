import { PermissionFlagsBits } from 'discord.js'

export const BOT_PERMISSION_NAMES = [
  'ManageChannels',
  'ViewChannel',
  'SendMessages',
  'ManageMessages',
  'AttachFiles',
  'ReadMessageHistory',
]

export const BOT_PERMISSIONS = BOT_PERMISSION_NAMES.reduce(
  (sum, name) => sum | PermissionFlagsBits[name],
  0n,
)

export function inviteUrl(clientId = '<CLIENT_ID>') {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`
}
