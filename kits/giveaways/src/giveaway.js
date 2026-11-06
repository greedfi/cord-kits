import { randomInt as cryptoRandomInt } from 'node:crypto'
import { cleanText } from './text.js'

export const MAX_ENTRIES = 10_000

export function newGiveawayId() {
  return Array.from({ length: 6 }, () => cryptoRandomInt(0, 256).toString(16).padStart(2, '0')).join('')
}

export function pickWinners(entries, count, randomInt = (max) => cryptoRandomInt(0, max)) {
  if (!Number.isInteger(count) || count < 1) throw new Error('Winner count must be a positive integer.')
  const pool = [...new Set(entries)]
  const winners = []
  const draws = Math.min(count, pool.length)
  for (let index = 0; index < draws; index += 1) {
    const choice = randomInt(pool.length)
    if (!Number.isInteger(choice) || choice < 0 || choice >= pool.length) {
      throw new Error('Winner selection received an out-of-range value.')
    }
    winners.push(pool.splice(choice, 1)[0])
  }
  return winners
}

export function entrantBlock(person, { requiredRoleId, minAccountAgeMs, now }) {
  if (!person) return 'left'
  if (person.bot) return 'bot'
  if (requiredRoleId && !(person.roleIds ?? []).includes(requiredRoleId)) return 'role'
  if (minAccountAgeMs > 0 && now - person.createdAt < minAccountAgeMs) return 'age'
  return null
}

export function partitionEntrants(entries, membersById, rules) {
  const accepted = []
  const rejected = []
  for (const id of entries) {
    const reason = entrantBlock(membersById.get(id) ?? null, rules)
    if (reason) rejected.push({ id, reason })
    else accepted.push(id)
  }
  return { accepted, rejected }
}

function guildMap(data, guildId) {
  if (!data.guilds || typeof data.guilds !== 'object') data.guilds = {}
  if (!data.guilds[guildId]) data.guilds[guildId] = {}
  return data.guilds[guildId]
}

export function readGiveaway(data, guildId, id) {
  return data.guilds?.[guildId]?.[id] ?? null
}

export function insertGiveaway(data, input) {
  const guild = guildMap(data, input.guildId)
  if (guild[input.id]) throw new Error('Giveaway id already exists.')
  guild[input.id] = {
    id: input.id,
    guildId: input.guildId,
    channelId: input.channelId,
    messageId: null,
    prize: input.prize,
    winnerCount: input.winnerCount,
    endAt: input.endAt,
    createdBy: input.createdBy,
    requiredRoleId: input.requiredRoleId ?? null,
    minAccountAgeMs: input.minAccountAgeMs ?? 0,
    entries: [],
    status: 'open',
    winnerIds: [],
    announcePending: true,
    rerolls: [],
    createdAt: input.now,
    endedAt: null,
  }
  return guild[input.id]
}

export function rememberMessage(giveaway, messageId) {
  if (giveaway.messageId && giveaway.messageId !== messageId) return false
  giveaway.messageId = messageId
  return true
}

export function joinGiveaway(giveaway, person, now) {
  if (giveaway.status !== 'open' || giveaway.endAt <= now) return { ok: false, reason: 'closed' }
  const blocked = entrantBlock(person, {
    requiredRoleId: giveaway.requiredRoleId,
    minAccountAgeMs: giveaway.minAccountAgeMs,
    now,
  })
  if (blocked) return { ok: false, reason: blocked }
  if (giveaway.entries.includes(person.id)) return { ok: false, reason: 'duplicate' }
  if (giveaway.entries.length >= MAX_ENTRIES) return { ok: false, reason: 'full' }
  giveaway.entries.push(person.id)
  giveaway.announcePending = true
  return { ok: true, count: giveaway.entries.length }
}

export function leaveGiveaway(giveaway, userId, now) {
  if (giveaway.status !== 'open' || giveaway.endAt <= now) return { ok: false, reason: 'closed' }
  const index = giveaway.entries.indexOf(userId)
  if (index === -1) return { ok: false, reason: 'absent' }
  giveaway.entries.splice(index, 1)
  giveaway.announcePending = true
  return { ok: true, count: giveaway.entries.length }
}

export function planEnd(giveaway, { now, membersById, randomInt }) {
  if (giveaway.status === 'cancelled') return { action: 'none' }
  if (giveaway.status === 'ended') return { action: giveaway.announcePending ? 'announce' : 'none' }
  if (giveaway.endAt > now) return { action: giveaway.announcePending ? 'announce' : 'none' }
  const { accepted } = partitionEntrants(giveaway.entries, membersById, {
    requiredRoleId: giveaway.requiredRoleId,
    minAccountAgeMs: giveaway.minAccountAgeMs,
    now,
  })
  giveaway.winnerIds = pickWinners(accepted, giveaway.winnerCount, randomInt)
  giveaway.status = 'ended'
  giveaway.endedAt = now
  giveaway.announcePending = true
  return { action: 'announce' }
}

export function planCancel(giveaway, now) {
  if (giveaway.status !== 'open') return { ok: false, reason: giveaway.status }
  giveaway.status = 'cancelled'
  giveaway.winnerIds = []
  giveaway.endedAt = now
  giveaway.announcePending = true
  return { ok: true }
}

export function planReroll(giveaway, { interactionId, now, randomInt }) {
  if (giveaway.status !== 'ended') return { ok: false, reason: 'not_ended' }
  const prior = giveaway.rerolls.find((item) => item.interactionId === interactionId)
  if (prior) return { ok: true, replay: true, winnerIds: [...prior.winnerIds] }
  const pool = giveaway.entries.filter((id) => !giveaway.winnerIds.includes(id))
  if (pool.length === 0) return { ok: false, reason: 'no_alternates' }
  const winnerIds = pickWinners(pool, Math.min(giveaway.winnerCount, pool.length), randomInt)
  giveaway.winnerIds = winnerIds
  giveaway.rerolls.push({ interactionId, winnerIds: [...winnerIds], at: now })
  giveaway.announcePending = true
  return { ok: true, replay: false, winnerIds }
}

export function dueIds(data, now) {
  const due = []
  for (const [guildId, guild] of Object.entries(data.guilds ?? {})) {
    for (const giveaway of Object.values(guild ?? {})) {
      const endedDue = giveaway.status === 'open' && giveaway.endAt <= now
      if (endedDue || giveaway.announcePending) due.push({ guildId, id: giveaway.id })
    }
  }
  return due
}

export function renderGiveaway(giveaway) {
  const prize = cleanText(giveaway.prize, 180)
  const lines = [
    `**Giveaway:** ${prize}`,
    `Ends <t:${Math.floor(giveaway.endAt / 1000)}:F> (${giveaway.winnerCount} winner(s), ${giveaway.entries.length} entered).`,
  ]
  if (giveaway.requiredRoleId) lines.push(`Required role: <@&${giveaway.requiredRoleId}>.`)
  if (giveaway.minAccountAgeMs > 0) {
    lines.push(`Account age: at least ${Math.round(giveaway.minAccountAgeMs / 3_600_000)} hour(s).`)
  }
  if (giveaway.status === 'ended') {
    lines.push(giveaway.winnerIds.length
      ? `Winners: ${giveaway.winnerIds.map((id) => `<@${id}>`).join(', ')}.`
      : 'No eligible entries. Nobody won.')
  } else if (giveaway.status === 'cancelled') {
    lines.push('Cancelled. No winners were drawn.')
  } else {
    lines.push('Press Join to enter or Leave to withdraw.')
  }
  return lines.join('\n').slice(0, 1900)
}

export function mentionPayload(giveaway) {
  return {
    parse: [],
    users: giveaway.status === 'ended' ? [...giveaway.winnerIds] : [],
  }
}
