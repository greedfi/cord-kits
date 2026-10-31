import { MessageFlags, PermissionFlagsBits } from 'discord.js'
import { MODERATION_BLOCK_REASON, moderationBlock } from './hierarchy.js'
import { selectPurgeMessages } from './purge.js'
import { setRaidEnabled } from './settings.js'
import { cleanText } from './text.js'

async function botMember(guild) {
  return guild.members.me ?? guild.members.fetchMe()
}

async function sendLog(guild, settings, text) {
  const channelId = settings?.modLogChannelId
  if (!channelId) return
  const channel = guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null)
  if (!channel?.isTextBased?.()) {
    console.error(`Mod log channel ${channelId} is not a text channel.`)
    return
  }
  await channel.send(cleanText(text, 1900)).catch((error) => {
    console.error(`Mod log failed: ${error.message}`)
  })
}

function hierarchy(actor, target, bot, ownerId) {
  return moderationBlock({
    actorId: actor.id,
    targetId: target.id,
    ownerId,
    botId: bot.id,
    actorHighest: actor.roles.highest.position,
    targetHighest: target.roles.highest.position,
    botHighest: bot.roles.highest.position,
  })
}

async function warn(interaction, ctx) {
  const user = interaction.options.getUser('user', true)
  const reason = cleanText(interaction.options.getString('reason', true))
  const member = await interaction.guild.members.fetch(user.id).catch(() => null)
  if (!member) return 'That user is not in this server.'
  const actor = await interaction.guild.members.fetch(interaction.user.id)
  if (member.id === actor.id) return MODERATION_BLOCK_REASON.self
  const result = ctx.warnings.add({
    guildId: interaction.guild.id,
    userId: member.id,
    moderatorId: actor.id,
    reason,
  })
  await member.send(`You were warned in ${interaction.guild.name}: ${reason}`).catch((error) => {
    console.error(`Could not DM ${member.id}: ${error.message}`)
  })
  const settings = ctx.configStore.get().guilds?.[interaction.guild.id]
  await sendLog(
    interaction.guild,
    settings,
    `warn: ${actor.user.tag} (${actor.id}) warned ${member.user.tag} (${member.id}) — ${reason} (warnings: ${result.count})`,
  )
  return `Warned ${member.user.tag}. They have ${result.count} warning(s) in this server.`
}

async function timeout(interaction, ctx) {
  const user = interaction.options.getUser('user', true)
  const minutes = interaction.options.getInteger('minutes', true)
  const reason = cleanText(interaction.options.getString('reason', true))
  const member = await interaction.guild.members.fetch(user.id).catch(() => null)
  if (!member) return 'That user is not in this server.'
  const actor = await interaction.guild.members.fetch(interaction.user.id)
  const bot = await botMember(interaction.guild)
  if (!bot.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return 'I need the Moderate Members permission.'
  }
  const blocked = hierarchy(actor, member, bot, interaction.guild.ownerId)
  if (blocked) return MODERATION_BLOCK_REASON[blocked]
  await member.timeout(minutes * 60 * 1000, reason)
  const settings = ctx.configStore.get().guilds?.[interaction.guild.id]
  await sendLog(
    interaction.guild,
    settings,
    `timeout: ${actor.user.tag} (${actor.id}) timed out ${member.user.tag} (${member.id}) for ${minutes} minute(s) — ${reason}`,
  )
  return `Timed out ${member.user.tag} for ${minutes} minute(s).`
}

async function kick(interaction, ctx) {
  const user = interaction.options.getUser('user', true)
  const reason = cleanText(interaction.options.getString('reason', true))
  const member = await interaction.guild.members.fetch(user.id).catch(() => null)
  if (!member) return 'That user is not in this server.'
  const actor = await interaction.guild.members.fetch(interaction.user.id)
  const bot = await botMember(interaction.guild)
  if (!bot.permissions.has(PermissionFlagsBits.KickMembers)) return 'I need the Kick Members permission.'
  const blocked = hierarchy(actor, member, bot, interaction.guild.ownerId)
  if (blocked) return MODERATION_BLOCK_REASON[blocked]
  await member.kick(reason)
  const settings = ctx.configStore.get().guilds?.[interaction.guild.id]
  await sendLog(
    interaction.guild,
    settings,
    `kick: ${actor.user.tag} (${actor.id}) kicked ${user.tag} (${user.id}) — ${reason}`,
  )
  return `Kicked ${user.tag}.`
}

async function ban(interaction, ctx) {
  const user = interaction.options.getUser('user', true)
  const reason = cleanText(interaction.options.getString('reason', true))
  const days = interaction.options.getInteger('delete_days') ?? 0
  const actor = await interaction.guild.members.fetch(interaction.user.id)
  const bot = await botMember(interaction.guild)
  if (!bot.permissions.has(PermissionFlagsBits.BanMembers)) return 'I need the Ban Members permission.'
  const member = await interaction.guild.members.fetch(user.id).catch(() => null)
  if (member) {
    const blocked = hierarchy(actor, member, bot, interaction.guild.ownerId)
    if (blocked) return MODERATION_BLOCK_REASON[blocked]
  } else if (user.id === actor.id) {
    return MODERATION_BLOCK_REASON.self
  } else if (user.id === bot.id) {
    return MODERATION_BLOCK_REASON.bot
  }
  await interaction.guild.members.ban(user.id, {
    deleteMessageSeconds: days * 24 * 60 * 60,
    reason,
  })
  const settings = ctx.configStore.get().guilds?.[interaction.guild.id]
  await sendLog(
    interaction.guild,
    settings,
    `ban: ${actor.user.tag} (${actor.id}) banned ${user.tag} (${user.id}), deleting ${days} day(s) of messages — ${reason}`,
  )
  return `Banned ${user.tag}.`
}

async function purge(interaction, ctx) {
  const count = interaction.options.getInteger('count', true)
  const user = interaction.options.getUser('user')
  const channel = interaction.channel
  if (!channel || typeof channel.bulkDelete !== 'function' || channel.isDMBased?.()) {
    return 'I can only purge messages in a server text channel.'
  }
  const bot = await botMember(interaction.guild)
  const permissions = channel.permissionsFor(bot)
  if (!permissions?.has(PermissionFlagsBits.ManageMessages) || !permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
    return 'I need Manage Messages and Read Message History in this channel.'
  }
  const fetched = await channel.messages.fetch({ limit: user ? 100 : count })
  const selected = selectPurgeMessages(
    [...fetched.values()].map((message) => ({
      id: message.id,
      authorId: message.author.id,
      createdAt: message.createdTimestamp,
    })),
    { userId: user?.id, now: Date.now(), limit: count },
  )
  const ids = new Set(selected.map((message) => message.id))
  const batch = fetched.filter((message) => ids.has(message.id))
  if (batch.size === 0) return 'No matching messages younger than 14 days.'
  const deleted = await channel.bulkDelete(batch, true)
  const settings = ctx.configStore.get().guilds?.[interaction.guild.id]
  const actor = interaction.user
  await sendLog(
    interaction.guild,
    settings,
    `purge: ${actor.tag} (${actor.id}) deleted ${deleted.size} message(s) in <#${channel.id}>${user ? ` from ${user.tag}` : ''}.`,
  )
  return `Deleted ${deleted.size} message(s).`
}

function raidReply(settings, enabled) {
  if (!enabled) return 'Raid mode is off. Slowmode on channels this bot changed is restored.'
  const lines = ['Raid mode is on.']
  if (settings.raidMode.channelIds.length === 0) {
    lines.push('channelIds is empty, so no slowmode was applied.')
  } else {
    lines.push(`Slowmode is ${settings.raidMode.slowmodeSeconds}s on ${settings.raidMode.channelIds.length} channel(s).`)
  }
  const hold = settings.raidMode.joinHold
  if (hold.type === 'timeout') lines.push(`New joins are timed out for ${hold.timeoutMinutes} minute(s).`)
  else if (hold.type === 'role' && hold.roleId) lines.push(`New joins receive the role <@&${hold.roleId}>.`)
  else if (hold.type === 'role') lines.push('Join hold is set to a role, but roleId is missing.')
  else lines.push('Join hold is off.')
  return lines.join(' ')
}

async function raid(interaction, ctx) {
  const enabled = interaction.options.getString('state', true) === 'on'
  const updated = ctx.configStore.update((draft) => setRaidEnabled(draft, interaction.guild.id, enabled))
  const settings = updated.config.guilds[interaction.guild.id]
  await sendLog(
    interaction.guild,
    settings,
    `raid: ${interaction.user.tag} (${interaction.user.id}) turned raid mode ${enabled ? 'on' : 'off'}.`,
  )
  return raidReply(settings, enabled)
}

const handlers = { warn, timeout, kick, ban, purge, raid }

export async function execute(interaction, ctx) {
  if (!interaction.isChatInputCommand()) return
  const handler = handlers[interaction.commandName]
  if (!handler) return
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This bot only works in servers.', flags: MessageFlags.Ephemeral })
    return
  }
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const content = await handler(interaction, ctx)
    await interaction.editReply(content)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    const text = error instanceof Error ? error.message : 'Command failed.'
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(text).catch((editError) => {
        console.error(`Could not report the command error: ${editError.message}`)
      })
    } else {
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch((replyError) => {
        console.error(`Could not report the command error: ${replyError.message}`)
      })
    }
  }
}
