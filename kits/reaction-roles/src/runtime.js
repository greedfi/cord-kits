import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} from 'discord.js'
import { redact } from './env.js'
import { createRateLimiter } from './limits.js'
import { inviteUrl } from './permissions.js'
import {
  newPanelId,
  planSelection,
  planToggle,
  roleBlock,
} from './roles.js'
import { cleanText } from './text.js'

const TEXT_CHANNELS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement])
const BUTTON_ID = /^rr:t:([0-9a-f]{16}):([0-9]{17,20})$/
const SELECT_ID = /^rr:s:([0-9a-f]{16})$/

export function guildOptions(config, guildId) {
  const override = config.guilds?.[guildId] ?? {}
  return {
    managerRoleId: override.managerRoleId ?? null,
    maxOptions: override.maxOptions ?? config.maxOptions,
  }
}

function roleIdsOf(member) {
  if (Array.isArray(member?.roleIds)) return member.roleIds
  if (member?.roles?.cache?.keys) return [...member.roles.cache.keys()]
  return []
}

export function canManage(member, managerRoleId) {
  if (typeof member?.permissions?.has === 'function' && member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return true
  }
  return Boolean(managerRoleId && roleIdsOf(member).includes(managerRoleId))
}

function readPanel(data, guildId, id) {
  return data.guilds?.[guildId]?.[id] ?? null
}

function guildMap(data, guildId) {
  if (!data.guilds) data.guilds = {}
  if (!data.guilds[guildId]) data.guilds[guildId] = {}
  return data.guilds[guildId]
}

async function ephemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral }
  if (interaction.deferred) return interaction.editReply({ content })
  if (interaction.replied) return interaction.followUp(payload)
  return interaction.reply(payload)
}

function rowsFor(panel) {
  if (panel.style === 'select') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rr:s:${panel.id}`)
      .setMinValues(0)
      .setMaxValues(Math.min(panel.maxRoles, panel.options.length))
      .setPlaceholder('Choose roles')
      .addOptions(panel.options.map((option) => ({
        label: option.label.slice(0, 100),
        value: option.roleId,
      })))
    return [new ActionRowBuilder().addComponents(menu)]
  }
  const rows = []
  for (let index = 0; index < panel.options.length; index += 5) {
    const slice = panel.options.slice(index, index + 5)
    rows.push(new ActionRowBuilder().addComponents(slice.map((option) => new ButtonBuilder()
      .setCustomId(`rr:t:${panel.id}:${option.roleId}`)
      .setLabel(option.label.slice(0, 80))
      .setStyle(ButtonStyle.Secondary))))
  }
  return rows
}

function messagePayload(panel) {
  return {
    content: cleanText(panel.title, 180),
    components: rowsFor(panel),
    allowedMentions: { parse: [] },
  }
}

export function createRuntime({
  configStore,
  store,
  fetchGuild,
  log = (message) => console.error(redact(message)),
  buttonLimiter = createRateLimiter({ limit: 5, windowMs: 10_000 }),
}) {
  let bound = null

  async function guildOf(guildId) {
    if (fetchGuild) return fetchGuild(guildId)
    if (!bound) throw new Error('Client is not ready.')
    return bound.guilds.fetch(guildId)
  }

  async function botContext(guild) {
    const me = guild.members.me ?? await guild.members.fetchMe()
    return {
      botHasManageRoles: Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)),
      botHighest: me?.roles?.highest?.position ?? 0,
      guildId: guild.id,
    }
  }

  async function requireManager(interaction) {
    const options = guildOptions(configStore.get(), interaction.guild.id)
    if (!canManage(interaction.member, options.managerRoleId)) {
      await ephemeral(interaction, 'You need Manage Roles, or the configured manager role, to do that.')
      return null
    }
    return options
  }

  async function create(interaction) {
    const options = await requireManager(interaction)
    if (!options) return
    const channel = interaction.options.getChannel('channel', true)
    const style = interaction.options.getString('style', true)
    const exclusive = interaction.options.getBoolean('exclusive', true)
    let maxRoles = interaction.options.getInteger('max_roles', true)
    const title = interaction.options.getString('title', true)
    if (!TEXT_CHANNELS.has(channel.type)) {
      await ephemeral(interaction, 'Pick a text or announcement channel.')
      return
    }
    if (exclusive) maxRoles = 1
    const id = newPanelId()
    await store.update((data) => {
      guildMap(data, interaction.guild.id)[id] = {
        id,
        guildId: interaction.guild.id,
        channelId: channel.id,
        messageId: null,
        style,
        exclusive,
        maxRoles,
        title,
        options: [],
      }
    })
    const note = exclusive ? ' Exclusive panels allow one role.' : ''
    await ephemeral(interaction, `Panel \`${id}\` is saved.${note} Add roles, then publish it.`)
  }

  async function addOption(interaction) {
    const options = await requireManager(interaction)
    if (!options) return
    const id = interaction.options.getString('panel', true)
    const role = interaction.options.getRole('role', true)
    const label = cleanText(interaction.options.getString('label', true), 80)
    const guild = await guildOf(interaction.guild.id)
    const block = roleBlock(role, await botContext(guild))
    if (!block.ok) {
      await ephemeral(interaction, roleRefusal(block))
      return
    }
    const result = await store.update((data) => {
      const panel = readPanel(data, interaction.guild.id, id)
      if (!panel) return { ok: false, reason: 'missing' }
      if (panel.options.some((option) => option.roleId === role.id)) return { ok: false, reason: 'duplicate' }
      if (panel.options.length >= options.maxOptions) return { ok: false, reason: 'full' }
      panel.options.push({ roleId: role.id, label })
      return { ok: true }
    })
    if (!result.ok) {
      const text = {
        missing: 'No panel with that id in this server.',
        duplicate: 'That role is already on the panel.',
        full: `This server allows ${options.maxOptions} roles on a panel.`,
      }[result.reason]
      await ephemeral(interaction, text)
      return
    }
    await ephemeral(interaction, `Added <@&${role.id}>. Publish the panel to update the message.`)
  }

  async function removeOption(interaction) {
    const options = await requireManager(interaction)
    if (!options) return
    const id = interaction.options.getString('panel', true)
    const role = interaction.options.getRole('role', true)
    const result = await store.update((data) => {
      const panel = readPanel(data, interaction.guild.id, id)
      if (!panel) return { ok: false, reason: 'missing' }
      const before = panel.options.length
      panel.options = panel.options.filter((option) => option.roleId !== role.id)
      return { ok: panel.options.length !== before, reason: 'absent' }
    })
    await ephemeral(interaction, result.ok ? 'Removed that role from the panel.' : 'That role is not on the panel.')
  }

  async function publish(interaction) {
    const options = await requireManager(interaction)
    if (!options) return
    const id = interaction.options.getString('panel', true)
    const snapshot = readPanel(await store.read(), interaction.guild.id, id)
    if (!snapshot) {
      await ephemeral(interaction, 'No panel with that id in this server.')
      return
    }
    if (snapshot.options.length === 0) {
      await ephemeral(interaction, 'Add at least one role before publishing.')
      return
    }
    const guild = await guildOf(interaction.guild.id)
    const context = await botContext(guild)
    for (const option of snapshot.options) {
      const role = await guild.roles.fetch(option.roleId).catch(() => null)
      const block = roleBlock(role, context)
      if (!block.ok) {
        await ephemeral(interaction, `Not posted. ${roleRefusal(block)} (<@&${option.roleId}>)`)
        return
      }
    }
    const channel = guild.channels.cache?.get(snapshot.channelId) ?? await guild.channels.fetch(snapshot.channelId)
    const me = guild.members.me
    const perms = channel.permissionsFor?.(me)
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
      await ephemeral(interaction, 'I need View Channel and Send Messages in that channel.')
      return
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const payload = messagePayload(snapshot)
    let messageId = snapshot.messageId
    if (!messageId) {
      const message = await channel.send(payload)
      messageId = message.id
    } else if (typeof channel.messages?.edit === 'function') {
      await channel.messages.edit(messageId, payload)
    } else {
      const message = await channel.messages.fetch(messageId)
      await message.edit(payload)
    }
    await store.update((data) => {
      const panel = readPanel(data, interaction.guild.id, id)
      if (panel && !panel.messageId) panel.messageId = messageId
    })
    await interaction.editReply(`Published \`${id}\`.`)
  }

  async function deletePanel(interaction) {
    const options = await requireManager(interaction)
    if (!options) return
    const id = interaction.options.getString('panel', true)
    const removed = await store.update((data) => {
      const guild = data.guilds?.[interaction.guild.id]
      if (!guild?.[id]) return false
      delete guild[id]
      return true
    })
    await ephemeral(interaction, removed
      ? `Deleted \`${id}\`. The old message stays; its buttons now do nothing.`
      : 'No panel with that id in this server.')
  }

  async function press(interaction, panelId, requested) {
    const decision = buttonLimiter.take(`${interaction.guild.id}:${interaction.user.id}`)
    if (!decision.allowed) {
      await ephemeral(interaction, 'You are pressing that too quickly.')
      return
    }
    const known = readPanel(await store.read(), interaction.guild.id, panelId)
    if (!known) {
      await ephemeral(interaction, 'This panel is no longer active.')
      return
    }
    let result
    try {
      result = await store.update(async (data) => {
        const panel = readPanel(data, interaction.guild.id, panelId)
        if (!panel) return { ok: false, reason: 'stale' }
        const guild = await guildOf(interaction.guild.id)
        const context = await botContext(guild)
        const member = await guild.members.fetch(interaction.user.id)
        const memberRoleIds = roleIdsOf(member)
        const plan = requested.kind === 'select'
          ? planSelection({
            memberRoleIds,
            panelRoleIds: panel.options.map((option) => option.roleId),
            selectedIds: requested.ids,
            maxRoles: panel.maxRoles,
          })
          : planToggle({
            memberRoleIds,
            panelRoleIds: panel.options.map((option) => option.roleId),
            roleId: requested.roleId,
            exclusive: panel.exclusive,
            maxRoles: panel.maxRoles,
          })
        if (!plan.ok) return plan
        for (const roleId of [...plan.add, ...plan.remove]) {
          const role = await guild.roles.fetch(roleId).catch(() => null)
          const block = roleBlock(role, context)
          if (!block.ok) {
            if (block.reason === 'missing_role') {
              panel.options = panel.options.filter((option) => option.roleId !== roleId)
              return { ok: false, reason: 'deleted' }
            }
            return { ok: false, reason: block.reason }
          }
        }
        if (plan.remove.length > 0) await member.roles.remove(plan.remove)
        if (plan.add.length > 0) await member.roles.add(plan.add)
        return { ok: true, add: plan.add, remove: plan.remove }
      })
    } catch (error) {
      log(`Role change failed: ${error.message}`)
      await ephemeral(interaction, 'Discord refused the role change. Nothing else was saved.')
      return
    }
    if (!result.ok) {
      const text = {
        max: 'You already have the maximum number of roles from this panel.',
        stale: 'This panel is no longer active.',
        unknown_role: 'That role is not on this panel.',
        deleted: 'That role was deleted. I removed it from the panel.',
        elevated: 'That role is privileged, so I will not assign or remove it.',
        managed: 'That role is managed by an integration, so I cannot assign it.',
        everyone: 'I cannot assign @everyone.',
        hierarchy: 'My highest role needs to be above that role.',
        missing_manage_roles: 'I need Manage Roles before I can change roles.',
      }[result.reason] ?? 'Could not change that role.'
      await ephemeral(interaction, text)
      return
    }
    const added = result.add.map((id) => `<@&${id}>`).join(', ')
    const removed = result.remove.map((id) => `<@&${id}>`).join(', ')
    const parts = []
    if (added) parts.push(`Added ${added}.`)
    if (removed) parts.push(`Removed ${removed}.`)
    await ephemeral(interaction, parts.join(' ') || 'No role change.')
  }

  async function handleInteraction(interaction) {
    try {
      if (interaction.isChatInputCommand?.() && interaction.commandName === 'roles') {
        if (!interaction.inGuild()) {
          await ephemeral(interaction, 'This bot only works in servers.')
          return
        }
        const sub = interaction.options.getSubcommand()
        if (sub === 'create') return create(interaction)
        if (sub === 'add') return addOption(interaction)
        if (sub === 'remove') return removeOption(interaction)
        if (sub === 'publish') return publish(interaction)
        if (sub === 'delete') return deletePanel(interaction)
        return
      }
      if (interaction.isButton?.()) {
        if (!interaction.inGuild()) {
          await ephemeral(interaction, 'This bot only works in servers.')
          return
        }
        const match = BUTTON_ID.exec(interaction.customId ?? '')
        if (match) {
          await press(interaction, match[1], { kind: 'button', roleId: match[2] })
          return
        }
        if (String(interaction.customId ?? '').startsWith('rr:')) {
          await ephemeral(interaction, 'This button is out of date.')
        }
        return
      }
      if (interaction.isStringSelectMenu?.()) {
        if (!interaction.inGuild()) {
          await ephemeral(interaction, 'This bot only works in servers.')
          return
        }
        const match = SELECT_ID.exec(interaction.customId ?? '')
        if (!match) {
          if (String(interaction.customId ?? '').startsWith('rr:')) {
            await ephemeral(interaction, 'This menu is out of date.')
          }
          return
        }
        await press(interaction, match[1], { kind: 'select', ids: interaction.values ?? [] })
      }
    } catch (error) {
      log(redact(error instanceof Error ? error.message : error))
      await ephemeral(interaction, 'Command failed.').catch(() => {})
    }
  }

  return {
    handleInteraction,
    bind(client) {
      bound = client
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

function roleRefusal(block) {
  if (block.reason === 'elevated') return 'That role is privileged. I will not assign it.'
  if (block.reason === 'managed') return 'That role is managed by an integration.'
  if (block.reason === 'everyone') return 'I cannot assign @everyone.'
  if (block.reason === 'hierarchy') return 'Move my highest role above that role first.'
  if (block.reason === 'missing_manage_roles') return 'I need the Manage Roles permission.'
  if (block.reason === 'missing_role') return 'That role no longer exists.'
  return 'That role cannot be assigned.'
}
