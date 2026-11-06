import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { redact } from './env.js'
import { createRateLimiter } from './limits.js'
import { inviteUrl } from './permissions.js'
import { joinDecision, renderTemplate, roleBlock } from './roles.js'
import { cleanText } from './text.js'

export const INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
const ACCEPT = 'welcome:accept'
const RULES_TEXT = 'Press this to record that you accept the server rules. This is not an identity check, captcha, or verification.'

function roleIdsOf(member) {
  if (Array.isArray(member?.roleIds)) return member.roleIds
  if (member?.roles?.cache?.keys) return [...member.roles.cache.keys()]
  return []
}

async function ephemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral }
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload)
  return interaction.reply(payload)
}

export function createRuntime({
  configStore,
  store,
  now = () => Date.now(),
  log = (message) => console.error(redact(message)),
  acceptLimiter = createRateLimiter({ limit: 3, windowMs: 10_000 }),
  lock = null,
}) {
  function held() {
    lock?.assertHeld?.()
  }
  async function channel(guild, id) {
    if (!id) return null
    return guild.channels.cache?.get(id) ?? await guild.channels.fetch(id).catch(() => null)
  }

  async function maybeAssign(guild, member, roleId) {
    if (!roleId) return { assigned: false, reason: 'unset' }
    const me = guild.members.me ?? await guild.members.fetchMe()
    const role = await guild.roles.fetch(roleId).catch(() => null)
    const block = roleBlock(role, {
      botHasManageRoles: Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)),
      botHighest: me?.roles?.highest?.position ?? 0,
      guildId: guild.id,
    })
    if (!block.ok) {
      log(`Did not assign ${roleId}: ${block.reason}.`)
      return { assigned: false, reason: block.reason }
    }
    if (roleIdsOf(member).includes(roleId)) return { assigned: false, reason: 'already' }
    await member.roles.add(roleId, 'Welcome kit role')
    return { assigned: true }
  }

  function ensureGuild(data, guildId) {
    if (!data.guilds) data.guilds = {}
    if (!data.guilds[guildId] || typeof data.guilds[guildId] !== 'object') {
      data.guilds[guildId] = { welcomed: {}, screening: {} }
    }
    const guild = data.guilds[guildId]
    if (!guild.welcomed || typeof guild.welcomed !== 'object') guild.welcomed = {}
    if (!guild.screening || typeof guild.screening !== 'object') guild.screening = {}
    return guild
  }

  function alreadyAnnounced(entry) {
    if (!entry) return false
    if (typeof entry === 'number') return true
    return entry.announced === true
  }

  async function welcome(member) {
    held()
    const settings = configStore.get().guilds?.[member.guild.id]
    if (!settings?.welcomeChannelId) return { sent: false }
    const decision = await store.update((data) => {
      const guild = ensureGuild(data, member.guild.id)
      const entry = guild.welcomed[member.id]
      if (alreadyAnnounced(entry) || entry?.inflight) return { send: false }
      guild.welcomed[member.id] = { at: now(), announced: false, inflight: true }
      return { send: true }
    })
    if (!decision.send) return { sent: false }
    try {
      const destination = await channel(member.guild, settings.welcomeChannelId)
      if (!destination?.send) {
        await store.update((data) => {
          const entry = ensureGuild(data, member.guild.id).welcomed[member.id]
          if (entry && typeof entry === 'object') entry.inflight = false
        })
        return { sent: false }
      }
      const content = cleanText(renderTemplate(settings.welcomeMessage, {
        userId: member.id,
        guildName: member.guild.name,
        memberCount: member.guild.memberCount,
      }), 1800)
      await destination.send({
        content,
        allowedMentions: { parse: [], users: [member.id] },
      })
      await store.update((data) => {
        const guild = ensureGuild(data, member.guild.id)
        const entry = guild.welcomed[member.id] ?? { at: now() }
        entry.announced = true
        entry.inflight = false
        guild.welcomed[member.id] = entry
      })
    } catch (error) {
      await store.update((data) => {
        const entry = ensureGuild(data, member.guild.id).welcomed[member.id]
        if (entry && typeof entry === 'object') entry.inflight = false
      }).catch(() => {})
      throw error
    }
    const role = await maybeAssign(member.guild, member, settings.autoRoleId)
    return { sent: true, role }
  }

  async function noteScreening(member) {
    await store.update((data) => {
      ensureGuild(data, member.guild.id).screening[member.id] = now()
    })
  }

  async function onJoin(member) {
    held()
    if (member?.pending !== false) {
      await noteScreening(member)
      return { action: member?.pending === true ? 'screening' : 'unknown' }
    }
    const decision = joinDecision(member)
    if (decision !== 'welcome') return { action: decision }
    return { action: 'welcome', ...(await welcome(member)) }
  }

  async function onUpdate(oldMember, newMember) {
    held()
    if (!newMember?.guild) return { action: 'ignore' }
    if (newMember.pending === true) {
      await noteScreening(newMember)
      return { action: 'screening' }
    }
    if (newMember.pending !== false) return { action: 'ignore' }
    const oldPending = oldMember?.pending
    const screening = (await store.read()).guilds?.[newMember.guild.id]?.screening?.[newMember.id]
    const finished = oldPending === true || (oldPending == null && Boolean(screening))
    if (!finished) return { action: 'ignore' }
    if (joinDecision(newMember) !== 'welcome') return { action: 'skip' }
    const result = await welcome(newMember)
    await store.update((data) => {
      delete ensureGuild(data, newMember.guild.id).screening[newMember.id]
    })
    return { action: 'screening-finished', ...result }
  }

  async function onLeave(member) {
    held()
    const settings = configStore.get().guilds?.[member.guild.id]
    await store.update((data) => {
      const guild = data.guilds?.[member.guild.id]
      if (guild?.welcomed) delete guild.welcomed[member.id]
      if (guild?.screening) delete guild.screening[member.id]
    })
    if (!settings?.leaveChannelId) return { sent: false }
    const destination = await channel(member.guild, settings.leaveChannelId)
    if (!destination?.send) return { sent: false }
    await destination.send({
      content: cleanText(renderTemplate(settings.leaveMessage, {
        userId: member.id,
        guildName: member.guild.name,
        memberCount: member.guild.memberCount,
      }), 1800),
      allowedMentions: { parse: [] },
    })
    return { sent: true }
  }

  async function accept(interaction) {
    held()
    if (!acceptLimiter.take(`${interaction.guild.id}:${interaction.user.id}`).allowed) {
      await ephemeral(interaction, 'You are pressing that too quickly. This is not an identity check.')
      return
    }
    if (interaction.member?.pending) {
      await ephemeral(interaction, 'Finish Discord membership screening first. This button does not bypass it, and it is not an identity check.')
      return
    }
    const settings = configStore.get().guilds?.[interaction.guild.id]
    if (!settings?.rulesRoleId) {
      await ephemeral(interaction, 'This server has no rules role configured. Accepting rules here is not an identity check.')
      return
    }
    const guild = interaction.guild
    const member = interaction.member?.roles
      ? interaction.member
      : await guild.members.fetch(interaction.user.id)
    const result = await maybeAssign(guild, member, settings.rulesRoleId)
    if (result.reason === 'already') {
      await ephemeral(interaction, 'You already accepted the rules. This is not an identity check.')
      return
    }
    if (!result.assigned) {
      await ephemeral(interaction, 'I did not assign that role. Accepting rules is not an identity check.')
      return
    }
    await ephemeral(interaction, 'Recorded that you accept the server rules. This is not an identity check, captcha, or verification.')
  }

  async function handleInteraction(interaction) {
    try {
      held()
      if (interaction.isChatInputCommand?.() && interaction.commandName === 'rules') {
        if (!interaction.inGuild()) {
          await ephemeral(interaction, 'This bot only works in servers.')
          return
        }
        if (!interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
          await ephemeral(interaction, 'You need Manage Roles to post the rules button.')
          return
        }
        const target = interaction.options.getChannel('channel', true)
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(ACCEPT).setLabel('I accept the rules').setStyle(ButtonStyle.Primary),
        )
        await target.send({ content: RULES_TEXT, components: [row], allowedMentions: { parse: [] } })
        await ephemeral(interaction, 'Posted the rules button. It records acceptance only. It is not verification.')
        return
      }
      if (interaction.isButton?.() && interaction.customId === ACCEPT) {
        if (!interaction.inGuild()) {
          await ephemeral(interaction, 'This bot only works in servers.')
          return
        }
        await accept(interaction)
        return
      }
      if (interaction.isButton?.() && String(interaction.customId ?? '').startsWith('welcome:')) {
        await ephemeral(interaction, 'That rules button is out of date. This is not an identity check.')
      }
    } catch (error) {
      log(redact(error instanceof Error ? error.message : error))
      if (error?.code === 'LEASE_LOST') return
      await ephemeral(interaction, 'Command failed.').catch(() => {})
    }
  }

  return {
    onJoin,
    onUpdate,
    onLeave,
    handleInteraction,
    bind(client) {
      client.on(Events.GuildMemberAdd, (member) => onJoin(member).catch((error) => log(redact(error.message ?? error))))
      client.on(Events.GuildMemberUpdate, (oldMember, newMember) => onUpdate(oldMember, newMember).catch((error) => log(redact(error.message ?? error))))
      client.on(Events.GuildMemberRemove, (member) => onLeave(member).catch((error) => log(redact(error.message ?? error))))
      client.on(Events.InteractionCreate, (interaction) => {
        handleInteraction(interaction).catch((error) => log(redact(error.message ?? error)))
      })
      client.once(Events.ClientReady, (ready) => {
        console.log(`Logged in as ${ready.user?.tag ?? 'bot'}`)
        const clientId = process.env.CLIENT_ID?.trim()
        if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
      })
    },
    shutdown() {},
  }
}
