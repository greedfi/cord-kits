import path from 'node:path'
import { OverwriteType, PermissionFlagsBits } from 'discord.js'

export function ticketOverwrites({ everyoneId, openerId, staffRoleId, botId }) {
  const view = PermissionFlagsBits.ViewChannel
  const send = PermissionFlagsBits.SendMessages
  const history = PermissionFlagsBits.ReadMessageHistory
  const attach = PermissionFlagsBits.AttachFiles
  const manage = PermissionFlagsBits.ManageMessages
  return [
    { id: everyoneId, type: OverwriteType.Role, deny: [view] },
    {
      id: openerId,
      type: OverwriteType.Member,
      allow: [view, send, history, attach],
    },
    {
      id: staffRoleId,
      type: OverwriteType.Role,
      allow: [view, send, history, attach, manage],
    },
    {
      id: botId,
      type: OverwriteType.Member,
      allow: [view, send, history, attach, manage, PermissionFlagsBits.ManageChannels],
    },
  ]
}

export function canViewTicket({ userId, roleIds = [], administrator = false, openerId, staffRoleId, botId }) {
  if (administrator) return { view: true, reason: 'administrator_bypass' }
  if (userId === openerId || userId === botId) return { view: true, reason: 'participant' }
  if (roleIds.includes(staffRoleId)) return { view: true, reason: 'staff' }
  return { view: false, reason: 'overwrite_deny' }
}

export function canReadTranscript({ roleIds = [], staffRoleId }) {
  return roleIds.includes(staffRoleId)
}

export function transcriptPath(root, guildId, ticketId) {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('Bad guild id.')
  if (!/^[0-9a-f]{12}$/.test(ticketId)) throw new Error('Bad ticket id.')
  const dir = path.resolve(root, 'transcripts', guildId)
  const file = path.resolve(dir, `${ticketId}.txt`)
  if (file !== path.join(dir, `${ticketId}.txt`)) throw new Error('Bad transcript path.')
  return file
}

export function formatTranscriptLine(message, now = Date.now()) {
  const text = String(message?.content ?? '').replace(/@(everyone|here)/gi, '@\u200b$1').trim() || '[no content]'
  const count = Array.isArray(message?.attachments)
    ? message.attachments.length
    : (message?.attachments?.size ?? 0)
  const files = count ? ` [${count} attachment(s) not copied]` : ''
  return `${new Date(message?.at ?? now).toISOString()} ${message?.authorId ?? 'unknown'}: ${text.slice(0, 500)}${files}`
}

export function activeTicket(data, guildId, openerId) {
  const guild = data.guilds?.[guildId] ?? {}
  return Object.values(guild).find((ticket) => ticket.openerId === openerId && ticket.status === 'open') ?? null
}
