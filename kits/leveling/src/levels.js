export const LEVEL_CAP = 200

export function xpToReach(level) {
  if (!Number.isInteger(level) || level < 0 || level > LEVEL_CAP) {
    throw new Error('Level is out of range.')
  }
  return 50 * level * (level + 1)
}

export function levelForXp(xp) {
  if (!Number.isInteger(xp) || xp < 0) throw new Error('XP must be a non-negative integer.')
  let level = 0
  while (level < LEVEL_CAP && xpToReach(level + 1) <= xp) level += 1
  return level
}

export function messageGate(message, settings) {
  if (!message.guild) return 'dm'
  if (message.author?.bot) return 'bot'
  if (message.system) return 'system'
  if (message.webhookId) return 'webhook'
  if ((settings?.excludedChannelIds ?? []).includes(message.channelId)) return 'channel'
  const roles = message.member?.roleIds ?? []
  if (roles.some((id) => (settings?.excludedRoleIds ?? []).includes(id))) return 'role'
  return null
}

export function decideAward({ xp = 0, lastAwardAt = 0, now, cooldownMs, amount }) {
  if (!Number.isInteger(amount) || amount < 1) throw new Error('XP amount must be a positive integer.')
  const cap = xpToReach(LEVEL_CAP)
  if (xp >= cap) return { award: false, reason: 'cap', xp, level: levelForXp(xp) }
  if (lastAwardAt && now - lastAwardAt < cooldownMs) {
    return { award: false, reason: 'cooldown', xp, level: levelForXp(xp) }
  }
  const before = levelForXp(xp)
  const next = Math.min(cap, xp + amount)
  const after = levelForXp(next)
  return { award: true, xp: next, lastAwardAt: now, before, after }
}

export function crossedRewards(before, after, rewards = []) {
  return rewards.filter((reward) => reward.level > before && reward.level <= after)
}

export function leaderboard(users, limit = 10) {
  return Object.entries(users ?? {})
    .map(([userId, row]) => ({
      userId,
      xp: row.xp ?? 0,
      level: levelForXp(row.xp ?? 0),
    }))
    .sort((a, b) => b.xp - a.xp || a.userId.localeCompare(b.userId))
    .slice(0, limit)
}
