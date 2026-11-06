import { PermissionFlagsBits } from 'discord.js'

const ELEVATED = [
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

export function renderTemplate(template, { userId, guildName, memberCount }) {
  const safeGuild = String(guildName ?? '').replace(/@(everyone|here)/gi, '@\u200b$1')
  return String(template ?? '')
    .replaceAll('{user}', `<@${userId}>`)
    .replaceAll('{guild}', safeGuild)
    .replaceAll('{memberCount}', String(memberCount ?? ''))
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .slice(0, 1800)
}

export function joinDecision(member) {
  if (!member || member.user?.bot || member.bot) return 'bot'
  if (member.pending) return 'screening'
  return 'welcome'
}
