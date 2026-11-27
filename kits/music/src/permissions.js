import { PermissionFlagsBits } from 'discord.js'

export const BOT_PERMISSION_NAMES = ['ViewChannel', 'SendMessages', 'Connect', 'Speak']

export const BOT_PERMISSIONS = BOT_PERMISSION_NAMES.reduce(
  (sum, name) => sum | PermissionFlagsBits[name],
  0n,
)

export const REQUEST_CHANNEL_PERMISSION_NAMES = [
  'ViewChannel',
  'SendMessages',
  'ManageMessages',
  'ReadMessageHistory',
  'Connect',
  'Speak',
]

export const REQUEST_CHANNEL_PERMISSIONS = REQUEST_CHANNEL_PERMISSION_NAMES.reduce(
  (sum, name) => sum | PermissionFlagsBits[name],
  0n,
)

export const SET_VOICE_CHANNEL_STATUS = PermissionFlagsBits.SetVoiceChannelStatus ?? (1n << 48n)

export const VOICE_STATUS_PERMISSIONS = BOT_PERMISSIONS | SET_VOICE_CHANNEL_STATUS

export function inviteUrl(clientId = '<CLIENT_ID>', permissions = BOT_PERMISSIONS) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${permissions}`
}
