import { randomInt } from 'node:crypto'
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

export function newPanelId() {
  return Array.from({ length: 8 }, () => randomInt(0, 256).toString(16).padStart(2, '0')).join('')
}

export function elevatedPermissionNames(role) {
  if (typeof role?.permissions?.has !== 'function') return []
  return ELEVATED_ROLE_PERMISSIONS.filter((name) => role.permissions.has(PermissionFlagsBits[name]))
}

export function roleBlock(role, { botHasManageRoles, botHighest, guildId }) {
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

export function planToggle({ memberRoleIds, panelRoleIds, roleId, exclusive, maxRoles }) {
  const panel = new Set(panelRoleIds)
  if (!panel.has(roleId)) return { ok: false, reason: 'unknown_role' }
  const mine = memberRoleIds.filter((id) => panel.has(id))
  if (mine.includes(roleId)) return { ok: true, add: [], remove: [roleId] }
  if (exclusive) return { ok: true, add: [roleId], remove: mine.filter((id) => id !== roleId) }
  if (mine.length >= maxRoles) return { ok: false, reason: 'max' }
  return { ok: true, add: [roleId], remove: [] }
}

export function planSelection({ memberRoleIds, panelRoleIds, selectedIds, maxRoles }) {
  const panel = new Set(panelRoleIds)
  const desired = [...new Set(selectedIds)].filter((id) => panel.has(id))
  if (desired.length > maxRoles) return { ok: false, reason: 'max' }
  const mine = memberRoleIds.filter((id) => panel.has(id))
  return {
    ok: true,
    add: desired.filter((id) => !mine.includes(id)),
    remove: mine.filter((id) => !desired.includes(id)),
  }
}

export function outsideRolesUntouched(memberRoleIds, panelRoleIds, change) {
  const panel = new Set(panelRoleIds)
  const outside = memberRoleIds.filter((id) => !panel.has(id))
  return outside.every((id) => !change.add.includes(id) && !change.remove.includes(id))
}
