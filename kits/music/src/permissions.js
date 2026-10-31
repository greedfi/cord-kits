import { PermissionFlagsBits } from 'discord.js'

export const BOT_PERMISSION_NAMES = ['ViewChannel', 'SendMessages', 'Connect', 'Speak']

export const BOT_PERMISSIONS = BOT_PERMISSION_NAMES.reduce(
  (sum, name) => sum | PermissionFlagsBits[name],
  0n,
)

export function inviteUrl(clientId = '<CLIENT_ID>') {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`
}
