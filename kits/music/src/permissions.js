import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js'

export const BASE_PERMISSION_NAMES = [
  'ViewChannel',
  'SendMessages',
  'EmbedLinks',
  'Connect',
  'Speak',
]

export const REQUEST_CHANNEL_PERMISSION_NAMES = ['ManageMessages']

export const VOICE_STATUS_PERMISSION = PermissionFlagsBits.SetVoiceChannelStatus

export function permissionInteger(names) {
  return names.reduce((sum, name) => sum | PermissionFlagsBits[name], 0n)
}

export const BOT_PERMISSIONS = permissionInteger(BASE_PERMISSION_NAMES)

export const REQUEST_CHANNEL_PERMISSIONS = permissionInteger([
  ...BASE_PERMISSION_NAMES,
  ...REQUEST_CHANNEL_PERMISSION_NAMES,
])

export const VOICE_STATUS_PERMISSIONS = BOT_PERMISSIONS | VOICE_STATUS_PERMISSION

export const REQUEST_AND_STATUS_PERMISSIONS = REQUEST_CHANNEL_PERMISSIONS | VOICE_STATUS_PERMISSION

export const BASE_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]

export const REQUEST_INTENTS = [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]

export function gatewayIntents(requestChannel) {
  return requestChannel ? [...BASE_INTENTS, ...REQUEST_INTENTS] : [...BASE_INTENTS]
}

export function inviteUrl(clientId = '<CLIENT_ID>', permissions = BOT_PERMISSIONS) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${permissions}`
}
