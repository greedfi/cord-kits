import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { redact } from './env.js'
import { inviteUrl } from './permissions.js'
import {
  activeTicket,
  canReadTranscript,
  formatTranscriptLine,
  ticketOverwrites,
  transcriptPath,
} from './privacy.js'
import { cleanText } from './text.js'

const OPEN_ID = 'ticket:open'
const CLOSE_ID = /^ticket:close:([0-9a-f]{12})$/
const YES_ID = /^ticket:yes:([0-9a-f]{12})$/
const NO_ID = /^ticket:no:([0-9a-f]{12})$/
const CONFIRM_MS = 120_000

function roleIdsOf(member) {
  if (Array.isArray(member?.roleIds)) return member.roleIds
  if (member?.roles?.cache?.keys) return [...member.roles.cache.keys()]
  return []
}

function isStaff(member, staffRoleId) {
  return Boolean(staffRoleId && roleIdsOf(member).includes(staffRoleId))
}

async function ephemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral }
  if (interaction.deferred) return interaction.editReply({ content })
  if (interaction.replied) return interaction.followUp(payload)
  return interaction.reply(payload)
}

export function createRuntime({
  configStore,
  store,
  now = () => Date.now(),
  fetchGuild,
  readMessages,
  fsImpl = fs,
  log = (message) => console.error(redact(message)),
}) {
  let bound = null

  async function guildOf(guildId) {
    if (fetchGuild) return fetchGuild(guildId)
    if (!bound) throw new Error('Client is not ready.')
    return bound.guilds.fetch(guildId)
  }

  function settingsFor(guildId) {
    return configStore.get().guilds?.[guildId] ?? null
  }

  function findByChannel(data, guildId, channelId) {
    const guild = data.guilds?.[guildId] ?? {}
    return Object.values(guild).find((ticket) => ticket.channelId === channelId && ticket.status === 'open') ?? null
  }

  async function openTicket(interaction, reason) {
    const settings = settingsFor(interaction.guild.id)
    if (!settings?.staffRoleId) {
      await ephemeral(interaction, 'This server has no staff role configured, so tickets stay closed.')
      return
    }
    const guild = await guildOf(interaction.guild.id)
    const me = guild.members.me ?? await guild.members.fetchMe()
    if (!me?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
      await ephemeral(interaction, 'I need Manage Channels to open a ticket.')
      return
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    let created = null
    let opened
    try {
      opened = await store.update(async (data) => {
      if (settings.oneActive !== false) {
        const existing = activeTicket(data, interaction.guild.id, interaction.user.id)
        if (existing) return { blocked: existing.id }
      }
      const id = randomBytes(6).toString('hex')
      const channel = await guild.channels.create({
        name: `ticket-${id}`,
        type: ChannelType.GuildText,
        parent: settings.categoryId ?? undefined,
        topic: cleanText(`Ticket ${id} for ${interaction.user.id}`, 200),
        permissionOverwrites: ticketOverwrites({
          everyoneId: guild.id,
          openerId: interaction.user.id,
          staffRoleId: settings.staffRoleId,
          botId: me.id,
        }),
        reason: `Ticket ${id} opened by ${interaction.user.id}`,
      })
      created = channel
      if (settings.categoryId && typeof channel.edit === 'function') {
        await channel.edit({
          permissionOverwrites: ticketOverwrites({
            everyoneId: guild.id,
            openerId: interaction.user.id,
            staffRoleId: settings.staffRoleId,
            botId: me.id,
          }),
          lockPermissions: false,
          reason: `Keep ticket ${id} unsynced from its category`,
        })
      }
      if (!data.guilds) data.guilds = {}
      if (!data.guilds[guild.id]) data.guilds[guild.id] = {}
      data.guilds[guild.id][id] = {
        id,
        guildId: guild.id,
        openerId: interaction.user.id,
        channelId: channel.id,
        status: 'open',
        reason: cleanText(reason ?? '', 200),
        createdAt: now(),
        closedAt: null,
        pendingCloseBy: null,
        pendingCloseAt: null,
      }
      return { id }
    })
    } catch (error) {
      if (created) await created.delete('Ticket state was not saved').catch(() => {})
      throw error
    }
    if (opened.blocked) {
      await interaction.editReply(`You already have an open ticket: \`${opened.blocked}\`.`)
      return
    }
    const channel = created
    const { id } = opened
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:close:${id}`).setLabel('Close').setStyle(ButtonStyle.Danger),
    )
    await channel.send({
      content: cleanText(`Ticket \`${id}\` opened by <@${interaction.user.id}>.${reason ? ` ${reason}` : ''}`, 1800),
      components: [row],
      allowedMentions: { parse: [], users: [interaction.user.id] },
    })
    await interaction.editReply(`Opened <#${channel.id}> (\`${id}\`).`)
  }

  async function askClose(interaction, ticketId) {
    const settings = settingsFor(interaction.guild.id)
    const data = await store.read()
    const ticket = ticketId
      ? data.guilds?.[interaction.guild.id]?.[ticketId]
      : findByChannel(data, interaction.guild.id, interaction.channelId ?? interaction.channel?.id)
    if (!ticket || ticket.status !== 'open') {
      await ephemeral(interaction, 'This is not an open ticket.')
      return
    }
    const staff = isStaff(interaction.member, settings?.staffRoleId)
    if (interaction.user.id !== ticket.openerId && !staff) {
      await ephemeral(interaction, 'Only the person who opened this ticket, or staff, can close it.')
      return
    }
    await store.update((draft) => {
      const live = draft.guilds[interaction.guild.id][ticket.id]
      live.pendingCloseBy = interaction.user.id
      live.pendingCloseAt = now()
    })
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:yes:${ticket.id}`).setLabel('Confirm close').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ticket:no:${ticket.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )
    await interaction.reply({
      content: 'Close this ticket? The channel will be deleted.',
      components: [row],
      flags: MessageFlags.Ephemeral,
    })
  }

  async function confirmClose(interaction, ticketId) {
    const settings = settingsFor(interaction.guild.id)
    const snapshot = (await store.read()).guilds?.[interaction.guild.id]?.[ticketId]
    if (!snapshot || snapshot.status !== 'open') {
      await ephemeral(interaction, 'This ticket is already closed.')
      return
    }
    const staff = isStaff(interaction.member, settings?.staffRoleId)
    const pendingFresh = snapshot.pendingCloseBy === interaction.user.id
      && now() - (snapshot.pendingCloseAt ?? 0) <= CONFIRM_MS
    if (!pendingFresh && !staff) {
      await ephemeral(interaction, 'That confirmation is not for you, or it expired.')
      return
    }
    const guild = await guildOf(interaction.guild.id)
    let channel
    try {
      channel = guild.channels.cache?.get(snapshot.channelId) ?? await guild.channels.fetch(snapshot.channelId)
    } catch (error) {
      if (error?.code !== 10003) throw error
      await store.update((draft) => {
        const live = draft.guilds?.[interaction.guild.id]?.[ticketId]
        if (live?.status === 'open') {
          live.status = 'closed'
          live.closedAt = now()
          live.pendingCloseBy = null
        }
      })
      await ephemeral(interaction, `Ticket \`${ticketId}\` was already removed in Discord.`)
      return
    }
    if (settings?.transcripts) {
      if (!staff) {
        await ephemeral(interaction, 'Transcripts are on. A staff member has to confirm the close.')
        return
      }
      const messages = await (readMessages ?? defaultRead)(channel)
      const lines = messages.map((message) => formatTranscriptLine(message, now))
      const file = transcriptPath(dataPathsRoot(), interaction.guild.id, ticketId)
      fsImpl.mkdirSync(path.dirname(file), { recursive: true })
      fsImpl.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
      fsImpl.chmodSync(file, 0o600)
    }
    await channel.delete(`Ticket ${ticketId} closed by ${interaction.user.id}`)
    await store.update((draft) => {
      const live = draft.guilds[interaction.guild.id][ticketId]
      live.status = 'closed'
      live.closedAt = now()
      live.pendingCloseBy = null
    })
    await ephemeral(interaction, `Closed \`${ticketId}\`.`)
  }

  function dataPathsRoot() {
    return configStore.dataRoot ?? process.env.DATA_DIR ?? 'data'
  }

  async function showTranscript(interaction) {
    const settings = settingsFor(interaction.guild.id)
    if (!canReadTranscript({ roleIds: roleIdsOf(interaction.member), staffRoleId: settings?.staffRoleId })) {
      await ephemeral(interaction, 'Only the configured staff role can read transcripts.')
      return
    }
    const id = interaction.options.getString('id', true)
    let file
    try {
      file = transcriptPath(dataPathsRoot(), interaction.guild.id, id)
    } catch {
      await ephemeral(interaction, 'That ticket id is not valid.')
      return
    }
    let text
    try {
      text = fsImpl.readFileSync(file, 'utf8')
    } catch {
      await ephemeral(interaction, 'No transcript is stored for that ticket.')
      return
    }
    await ephemeral(interaction, cleanText(text, 1800) || 'Transcript is empty.')
  }

  async function handleInteraction(interaction) {
    try {
      if (interaction.isChatInputCommand?.() && interaction.commandName === 'ticket') {
        if (!interaction.inGuild()) {
          await ephemeral(interaction, 'This bot only works in servers.')
          return
        }
        const sub = interaction.options.getSubcommand()
        if (sub === 'panel') {
          if (!interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
            await ephemeral(interaction, 'You need Manage Channels to post a ticket panel.')
            return
          }
          const channel = interaction.options.getChannel('channel', true)
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(OPEN_ID).setLabel('Open a ticket').setStyle(ButtonStyle.Primary),
          )
          await channel.send({
            content: 'Open a private ticket. This is a channel only you and staff can see. Server administrators can still open every channel.',
            components: [row],
            allowedMentions: { parse: [] },
          })
          await ephemeral(interaction, 'Posted the ticket button.')
          return
        }
        if (sub === 'open') {
          await openTicket(interaction, interaction.options.getString('reason'))
          return
        }
        if (sub === 'close') {
          await askClose(interaction)
          return
        }
        if (sub === 'transcript') await showTranscript(interaction)
        return
      }
      if (!interaction.isButton?.() || !interaction.inGuild()) return
      if (interaction.customId === OPEN_ID) {
        await openTicket(interaction, '')
        return
      }
      const close = CLOSE_ID.exec(interaction.customId ?? '')
      if (close) {
        await askClose(interaction, close[1])
        return
      }
      const yes = YES_ID.exec(interaction.customId ?? '')
      if (yes) {
        await confirmClose(interaction, yes[1])
        return
      }
      const no = NO_ID.exec(interaction.customId ?? '')
      if (no) {
        await store.update((draft) => {
          const live = draft.guilds?.[interaction.guild.id]?.[no[1]]
          if (live?.pendingCloseBy === interaction.user.id) {
            live.pendingCloseBy = null
            live.pendingCloseAt = null
          }
        })
        await ephemeral(interaction, 'Close cancelled.')
        return
      }
      if (String(interaction.customId ?? '').startsWith('ticket:')) {
        await ephemeral(interaction, 'That ticket button is out of date.')
      }
    } catch (error) {
      log(redact(error instanceof Error ? error.message : error))
      await ephemeral(interaction, 'Command failed.').catch(() => {})
    }
  }

  async function resyncOpenTickets() {
    const data = await store.read()
    for (const [guildId, tickets] of Object.entries(data.guilds ?? {})) {
      const settings = settingsFor(guildId)
      if (!settings?.staffRoleId) continue
      for (const ticket of Object.values(tickets)) {
        if (ticket.status !== 'open') continue
        try {
          const guild = await guildOf(guildId)
          const me = guild.members.me ?? await guild.members.fetchMe()
          const channel = guild.channels.cache?.get(ticket.channelId) ?? await guild.channels.fetch(ticket.channelId)
          const overwrites = ticketOverwrites({
            everyoneId: guild.id,
            openerId: ticket.openerId,
            staffRoleId: settings.staffRoleId,
            botId: me.id,
          })
          if (typeof channel.edit === 'function') {
            await channel.edit({
              permissionOverwrites: overwrites,
              lockPermissions: false,
              reason: `Refresh access for ticket ${ticket.id}`,
            })
          }
        } catch (error) {
          log(`Ticket ${ticket.id} permissions were not refreshed: ${error.message}`)
        }
      }
    }
  }

  return {
    handleInteraction,
    resyncOpenTickets,
    bind(client) {
      bound = client
      client.on(Events.InteractionCreate, (interaction) => {
        handleInteraction(interaction).catch((error) => log(redact(error.message ?? error)))
      })
      client.once(Events.ClientReady, (ready) => {
        console.log(`Logged in as ${ready.user?.tag ?? 'bot'}`)
        const clientId = process.env.CLIENT_ID?.trim()
        if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
        resyncOpenTickets().catch((error) => log(redact(error.message ?? error)))
      })
      if (typeof configStore.onReload === 'function') {
        configStore.onReload(() => {
          resyncOpenTickets().catch((error) => log(redact(error.message ?? error)))
        })
      }
    },
    shutdown() {},
  }
}

async function defaultRead(channel) {
  const fetched = await channel.messages.fetch({ limit: 100 })
  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => ({
      authorId: message.author?.id,
      content: message.content ?? '',
      at: message.createdTimestamp,
    }))
}
