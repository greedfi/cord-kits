import { PermissionFlagsBits } from 'discord.js'
import { messageViolation } from './filters.js'

export function exemptionFor(member, settings) {
  const perms = member?.permissions
  if (!member || typeof perms?.has !== 'function') return 'unresolved'
  if (perms.has(PermissionFlagsBits.Administrator)) return 'administrator'
  if (perms.has(PermissionFlagsBits.ModerateMembers)) return 'moderator'
  if (perms.has(PermissionFlagsBits.ManageMessages)) return 'manage_messages'
  const roles = member.roleIds ?? []
  const configured = settings?.exemptRoleIds ?? []
  if (configured.some((id) => roles.includes(id))) return 'role'
  return null
}

export async function handleAutomod(message, { settings, limiter, fetchMember, log } = {}) {
  if (!message.guild || message.author?.bot || !message.content) return { action: 'ignore' }
  const hit = messageViolation(message.content, settings)
  if (!hit) return { action: 'clean' }
  let member = message.member ?? null
  if (!member && fetchMember) {
    try {
      member = await fetchMember(message.author.id)
    } catch {
      member = null
    }
  }
  const exemption = exemptionFor(member, settings)
  if (exemption) return { action: 'exempt', exemption, hit }
  if (limiter) {
    const decision = limiter.take(message.guild.id)
    if (!decision.allowed) {
      if (decision.notify && log) {
        await log(`filter: rate limit reached in <#${message.channel?.id ?? 'unknown'}>. Matching messages were left in place until the window passed.`)
      }
      return { action: 'rate_limited', hit }
    }
  }
  if (message.deletable === false) return { action: 'not_deletable', hit }
  const reason = `Filter (${hit.type})`.slice(0, 512)
  await message.delete(reason)
  if (log) {
    await log(`filter: deleted a message from ${message.author.tag} (${message.author.id}) in <#${message.channel.id}> (${hit.type}: ${hit.detail}).`)
  }
  return { action: 'deleted', hit, reason }
}
