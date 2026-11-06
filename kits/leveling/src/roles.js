import { PermissionFlagsBits } from 'discord.js'

const ELEVATED = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks',
  'ManageMessages', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone',
  'MuteMembers', 'DeafenMembers', 'MoveMembers', 'ManageNicknames', 'ManageThreads',
]

export function roleBlock(role, { botHasManageRoles, botHighest, guildId }) {
  if (!botHasManageRoles) return { ok: false, reason: 'missing_manage_roles' }
  if (!role) return { ok: false, reason: 'missing_role' }
  if (role.managed) return { ok: false, reason: 'managed' }
  if (role.id === guildId) return { ok: false, reason: 'everyone' }
  if (typeof role.position !== 'number' || role.position >= botHighest) return { ok: false, reason: 'hierarchy' }
  const elevated = ELEVATED.filter((name) => role.permissions?.has?.(PermissionFlagsBits[name]))
  if (elevated.length) return { ok: false, reason: 'elevated', permissions: elevated }
  return { ok: true }
}
