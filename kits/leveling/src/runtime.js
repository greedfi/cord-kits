import { Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { redact } from './env.js'
import {
  crossedRewards,
  decideAward,
  leaderboard,
  levelForXp,
  messageGate,
} from './levels.js'
import { createRateLimiter } from './limits.js'
import { inviteUrl } from './permissions.js'
import { roleBlock } from './roles.js'

export const INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]

function guildSettings(config, guildId) {
  const override = config.guilds?.[guildId] ?? {}
  return {
    xpPerMessage: override.xpPerMessage ?? config.xpPerMessage,
    cooldownMs: (override.cooldownSeconds ?? config.cooldownSeconds) * 1000,
    excludedChannelIds: override.excludedChannelIds ?? [],
    excludedRoleIds: override.excludedRoleIds ?? [],
    rewards: override.rewards ?? [],
  }
}

function ensureGuild(data, guildId) {
  if (!data.guilds) data.guilds = {}
  if (!data.guilds[guildId]) data.guilds[guildId] = { users: {}, pending: {}, skipped: {} }
  const guild = data.guilds[guildId]
  guild.users ??= {}
  guild.pending ??= {}
  guild.skipped ??= {}
  return guild
}

async function ephemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload)
  return interaction.reply(payload)
}

export function createRuntime({
  configStore,
  store,
  now = () => Date.now(),
  fetchGuild,
  burst = createRateLimiter({ limit: 20, windowMs: 10_000 }),
  log = (message) => console.error(redact(message)),
  lock = null,
}) {
  function held() {
    lock?.assertHeld?.()
  }
  let bound = null

  async function guildOf(guildId) {
    held()
    if (fetchGuild) return fetchGuild(guildId)
    if (!bound) throw new Error('Client is not ready.')
    return bound.guilds.fetch(guildId)
  }

  async function grant(guildId, userId, roleId) {
    held()
    const guild = await guildOf(guildId)
    const me = guild.members.me ?? await guild.members.fetchMe()
    const role = await guild.roles.fetch(roleId).catch(() => null)
    const block = roleBlock(role, {
      botHasManageRoles: Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)),
      botHighest: me?.roles?.highest?.position ?? 0,
      guildId,
    })
    if (!block.ok) return { granted: false, reason: block.reason }
    const member = await guild.members.fetch(userId)
    await member.roles.add(roleId, 'Level reward')
    return { granted: true }
  }

  async function forget(guildId, userId, roleId, bucket) {
    await store.update((data) => {
      const guild = ensureGuild(data, guildId)
      const list = new Set(guild[bucket][userId] ?? [])
      list.delete(roleId)
      if (list.size) guild[bucket][userId] = [...list]
      else delete guild[bucket][userId]
    })
  }

  async function applyPending(guildId, userId, roleIds) {
    for (const roleId of roleIds) {
      try {
        const result = await grant(guildId, userId, roleId)
        if (result.granted) await forget(guildId, userId, roleId, 'pending')
        else {
          await forget(guildId, userId, roleId, 'pending')
          await store.update((data) => {
            const guild = ensureGuild(data, guildId)
            const skipped = new Set(guild.skipped[userId] ?? [])
            skipped.add(roleId)
            guild.skipped[userId] = [...skipped]
          })
        }
      } catch (error) {
        log(`Level reward ${roleId} for ${userId} stays pending: ${error.message}`)
      }
    }
  }

  async function onMessage(message) {
    held()
    const settings = message.guild ? guildSettings(configStore.get(), message.guild.id) : null
    const gate = messageGate(message, settings)
    if (gate) return { awarded: false, reason: gate }
    if (!burst.take(message.guild.id).allowed) return { awarded: false, reason: 'guild_rate' }
    const result = await store.update((data) => {
      const guild = ensureGuild(data, message.guild.id)
      const current = guild.users[message.author.id] ?? { xp: 0, lastAwardAt: 0 }
      const decision = decideAward({
        xp: current.xp,
        lastAwardAt: current.lastAwardAt,
        now: now(),
        cooldownMs: settings.cooldownMs,
        amount: settings.xpPerMessage,
      })
      if (!decision.award) return decision
      guild.users[message.author.id] = { xp: decision.xp, lastAwardAt: decision.lastAwardAt }
      const gained = crossedRewards(decision.before, decision.after, settings.rewards)
        .map((reward) => reward.roleId)
        .filter((roleId) => !(guild.skipped[message.author.id] ?? []).includes(roleId))
      if (gained.length) {
        const pending = new Set([...(guild.pending[message.author.id] ?? []), ...gained])
        guild.pending[message.author.id] = [...pending]
      }
      return { ...decision, grant: gained }
    })
    if (result.grant?.length) await applyPending(message.guild.id, message.author.id, result.grant)
    return result
  }

  async function reconcile() {
    held()
    const data = await store.read()
    for (const [guildId, guild] of Object.entries(data.guilds ?? {})) {
      for (const [userId, roleIds] of Object.entries(guild.pending ?? {})) {
        await applyPending(guildId, userId, roleIds)
      }
    }
  }

  async function rank(interaction) {
    const user = interaction.options.getUser('user') ?? interaction.user
    const data = await store.read()
    const users = data.guilds?.[interaction.guild.id]?.users ?? {}
    const row = users[user.id] ?? { xp: 0, lastAwardAt: 0 }
    const board = leaderboard(users, Object.keys(users).length || 1)
    const place = board.findIndex((entry) => entry.userId === user.id) + 1
    await ephemeral(interaction, `${user.tag ?? user.id} is level ${levelForXp(row.xp)} with ${row.xp} XP${place ? `, rank ${place}` : ''}.`)
  }

  async function board(interaction) {
    const users = (await store.read()).guilds?.[interaction.guild.id]?.users ?? {}
    const rows = leaderboard(users, 10)
    if (!rows.length) {
      await ephemeral(interaction, 'No XP has been recorded in this server.')
      return
    }
    const lines = rows.map((row, index) => `${index + 1}. <@${row.userId}> level ${row.level} (${row.xp} XP)`)
    await ephemeral(interaction, lines.join('\n'))
  }

  async function handleInteraction(interaction) {
    try {
      held()
      if (!interaction.isChatInputCommand?.() || !interaction.inGuild()) {
        if (interaction.isChatInputCommand?.()) await ephemeral(interaction, 'This bot only works in servers.')
        return
      }
      if (interaction.commandName === 'rank') await rank(interaction)
      if (interaction.commandName === 'leaderboard') await board(interaction)
    } catch (error) {
      log(redact(error instanceof Error ? error.message : error))
      if (error?.code === 'LEASE_LOST') return
      await ephemeral(interaction, 'Command failed.').catch(() => {})
    }
  }

  return {
    onMessage,
    reconcile,
    handleInteraction,
    bind(client) {
      bound = client
      client.on(Events.MessageCreate, (message) => {
        onMessage(message).catch((error) => log(redact(error.message ?? error)))
      })
      client.on(Events.InteractionCreate, (interaction) => {
        handleInteraction(interaction).catch((error) => log(redact(error.message ?? error)))
      })
      client.once(Events.ClientReady, (ready) => {
        console.log(`Logged in as ${ready.user?.tag ?? 'bot'}`)
        const clientId = process.env.CLIENT_ID?.trim()
        if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
        reconcile().catch((error) => log(redact(error.message ?? error)))
      })
    },
    shutdown() {},
  }
}
