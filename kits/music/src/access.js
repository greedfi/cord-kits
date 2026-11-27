import { PermissionFlagsBits } from 'discord.js'

export const DJ_COMMANDS = [
  'play',
  'playskip',
  'playtop',
  'pause',
  'resume',
  'skip',
  'back',
  'replay',
  'stop',
  'loop',
  'shuffle',
  'move',
  'remove',
  'clear',
  'seek',
  'forward',
  'rewind',
  'volume',
  'join',
  'leave',
  'search',
  'filter',
  'playlist',
  'queue',
  'nowplaying',
  'sleep',
]

export const DEFAULT_DJ_ONLY = [
  'playskip',
  'playtop',
  'pause',
  'resume',
  'skip',
  'back',
  'replay',
  'stop',
  'loop',
  'shuffle',
  'move',
  'remove',
  'clear',
  'seek',
  'forward',
  'rewind',
  'volume',
  'filter',
  'leave',
]

export const CONFIG_COMMANDS = new Set([
  'setup',
  'setdj',
  'setdjonly',
  'texttoggle',
  'voicetoggle',
  'settings',
  'stay',
])

const DJ_SET = new Set(DJ_COMMANDS)

export function isDjCommand(name) {
  return DJ_SET.has(name)
}

export function hasManageGuild(member) {
  return Boolean(member?.permissions?.has?.(PermissionFlagsBits.ManageGuild))
}

export function hasRole(member, roleId) {
  if (!roleId) return false
  if (typeof member?.roles?.cache?.has === 'function') return member.roles.cache.has(roleId)
  if (Array.isArray(member?.roles)) return member.roles.includes(roleId)
  return false
}

export function commandDenial({
  command,
  member,
  channelId,
  voiceChannelId = null,
  settings,
  configuring = false,
}) {
  if (!member) return 'Could not read your member profile.'
  if (
    settings.requestCommandsOnly
    && settings.requestChannelId
    && !configuring
    && channelId !== settings.requestChannelId
  ) {
    return 'Commands are limited to the song request channel.'
  }
  if (settings.textLock && !configuring && !settings.textChannels.includes(channelId)) {
    return 'This bot only accepts commands in the allowed text channels.'
  }
  if (
    voiceChannelId
    && settings.voiceLock
    && !settings.voiceChannels.includes(voiceChannelId)
    && !hasManageGuild(member)
  ) {
    return 'That voice channel is not allowed.'
  }
  if (settings.djRoleId && settings.djOnly.includes(command)) {
    if (!hasRole(member, settings.djRoleId) && !hasManageGuild(member)) {
      return 'That command is limited to the DJ role.'
    }
  }
  return null
}
