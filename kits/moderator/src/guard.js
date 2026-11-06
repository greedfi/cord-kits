import { PermissionFlagsBits } from 'discord.js'

export const ELEVATED_ROLE_PERMISSIONS = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageWebhooks',
  'ManageMessages',
  'BanMembers',
  'KickMembers',
  'ModerateMembers',
  'MentionEveryone',
  'MuteMembers',
  'DeafenMembers',
  'MoveMembers',
  'ManageNicknames',
  'ManageThreads',
]

export function elevatedPermissionNames(role) {
  if (typeof role?.permissions?.has !== 'function') return []
  return ELEVATED_ROLE_PERMISSIONS.filter((name) => role.permissions.has(PermissionFlagsBits[name]))
}

export function assessJoinHoldRole(role, { botHasManageRoles, botHighest, guildId }) {
  if (!botHasManageRoles) return { ok: false, reason: 'missing_manage_roles' }
  if (!role) return { ok: false, reason: 'missing_role' }
  if (role.managed) return { ok: false, reason: 'managed' }
  if (role.id === guildId) return { ok: false, reason: 'everyone' }
  if (typeof role.position !== 'number' || role.position >= botHighest) {
    return { ok: false, reason: 'hierarchy' }
  }
  const elevated = elevatedPermissionNames(role)
  if (elevated.length > 0) return { ok: false, reason: 'elevated', permissions: elevated }
  return { ok: true }
}

export function assessJoinHoldTimeout({
  botHasModerate,
  member,
  botId,
  ownerId,
  botHighest,
}) {
  if (!botHasModerate) return { ok: false, reason: 'missing_moderate_members' }
  if (!member) return { ok: false, reason: 'missing_member' }
  if (member.id === botId) return { ok: false, reason: 'bot' }
  if (member.id === ownerId) return { ok: false, reason: 'owner' }
  if (typeof member.moderatable === 'boolean') {
    return member.moderatable
      ? { ok: true }
      : { ok: false, reason: 'not_moderatable' }
  }
  const targetHighest = member.roles?.highest?.position ?? 0
  if (targetHighest >= botHighest) return { ok: false, reason: 'hierarchy' }
  return { ok: true }
}
