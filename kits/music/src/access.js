import { PermissionFlagsBits } from 'discord.js'
import { BUTTON_COMMANDS, CONFIG_COMMANDS } from './catalog.js'

const CONFIG = new Set(CONFIG_COMMANDS)

export function canConfigure(member) {
  const permissions = member?.permissions
  if (!permissions?.has) return false
  return permissions.has(PermissionFlagsBits.Administrator)
    || permissions.has(PermissionFlagsBits.ManageGuild)
}

export function isDj(member, settings) {
  if (!settings.djRoleId) return false
  const roles = member?.roles
  if (!roles) return false
  if (typeof roles.cache?.has === 'function') return roles.cache.has(settings.djRoleId)
  if (roles instanceof Set) return roles.has(settings.djRoleId)
  if (Array.isArray(roles)) return roles.includes(settings.djRoleId)
  return false
}

export function commandForButton(customId, snapshot) {
  const command = BUTTON_COMMANDS[customId]
  if (!command) return null
  if (customId === 'np:pause' && snapshot?.paused) return 'resume'
  return command
}

function textAllowed(settings, channelId, requestChannelActive) {
  if (settings.textChannels.length === 0) return true
  if (requestChannelActive && settings.requestChannelId && channelId === settings.requestChannelId) {
    return true
  }
  return settings.textChannels.includes(channelId)
}

export function authorize({
  commandName,
  settings,
  member,
  channelId,
  requestChannelActive,
}) {
  if (CONFIG.has(commandName)) {
    if (!canConfigure(member)) return 'You need Manage Guild to change server settings.'
    return null
  }
  if (
    requestChannelActive
    && settings.requestCommandsOnly
    && settings.requestChannelId
    && channelId !== settings.requestChannelId
  ) {
    return 'Music commands are limited to the request channel.'
  }
  if (!textAllowed(settings, channelId, requestChannelActive)) {
    return 'This bot is limited to other text channels.'
  }
  if (settings.djRoleId && settings.djOnly.includes(commandName) && !isDj(member, settings) && !canConfigure(member)) {
    return 'That command is limited to the DJ role.'
  }
  return null
}

const VOICE_JOIN_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.Connect, 'Connect'],
  [PermissionFlagsBits.Speak, 'Speak'],
]

export function missingVoicePermissions(channel, member) {
  if (typeof channel?.permissionsFor !== 'function' || !member) return null
  let permissions
  try {
    permissions = channel.permissionsFor(member)
  } catch {
    return null
  }
  if (typeof permissions?.has !== 'function') return null
  return VOICE_JOIN_PERMISSIONS
    .filter(([bit]) => !permissions.has(bit))
    .map(([, label]) => label)
}

export function voicePermissionMessage(channel, missing) {
  const names = missing.length <= 1
    ? missing[0]
    : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`
  const where = channel?.id ? `<#${channel.id}>` : 'that voice channel'
  return `I need ${names} in ${where}; check the channel or category permissions.`
}

export function voiceAllowed(settings, channelId) {
  if (!channelId) return true
  if (settings.voiceChannels.length === 0) return true
  return settings.voiceChannels.includes(channelId)
}
