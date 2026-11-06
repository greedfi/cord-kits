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
import {
  announcementMarker,
  dueIds,
  giveawayNonce,
  HISTORY_PAGE,
  HISTORY_PAGES,
  insertGiveaway,
  joinGiveaway,
  leaveGiveaway,
  markSending,
  mentionPayload,
  newGiveawayId,
  planCancel,
  planEnd,
  planReroll,
  readGiveaway,
  rememberMessage,
  renderGiveaway,
  scanAnnouncementPages,
} from './giveaway.js'
import { createRateLimiter } from './limits.js'
import { inviteUrl } from './permissions.js'

const TEXT_CHANNELS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement])
const JOIN_ID = /^gw:join:([0-9a-f]{12})$/
const LEAVE_ID = /^gw:leave:([0-9a-f]{12})$/

export function guildOptions(config, guildId) {
  const override = config.guilds?.[guildId] ?? {}
  return {
    managerRoleId: override.managerRoleId ?? null,
    minAccountAgeMs: (override.minAccountAgeHours ?? config.minAccountAgeHours) * 3_600_000,
    maxWinners: override.maxWinners ?? config.maxWinners,
    maxDurationMinutes: override.maxDurationMinutes ?? config.maxDurationMinutes,
  }
}

export function canManage(member, managerRoleId) {
  if (typeof member?.permissions?.has === 'function' && member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true
  }
  const roles = member?.roleIds
    ?? (member?.roles?.cache ? [...member.roles.cache.keys()] : [])
  return Boolean(managerRoleId && roles.includes(managerRoleId))
}

function roleIdsOf(member) {
  if (member?.roleIds) return member.roleIds
  if (member?.roles?.cache) return [...member.roles.cache.keys()]
  return []
}

function personFrom(interaction) {
  return {
    id: interaction.user.id,
    bot: Boolean(interaction.user.bot),
    roleIds: roleIdsOf(interaction.member),
    createdAt: interaction.user.createdTimestamp ?? 0,
  }
}

function componentsFor(giveaway) {
  if (giveaway.status !== 'open') return []
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gw:join:${giveaway.id}`)
        .setLabel('Join')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`gw:leave:${giveaway.id}`)
        .setLabel('Leave')
        .setStyle(ButtonStyle.Secondary),
    ),
  ]
}

function payloadFor(giveaway) {
  return {
    content: renderGiveaway(giveaway),
    components: componentsFor(giveaway),
    allowedMentions: mentionPayload(giveaway),
  }
}

async function ephemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral }
  if (interaction.deferred || interaction.replied) {
    if (typeof interaction.editReply === 'function' && interaction.deferred) {
      return interaction.editReply({ content })
    }
    return interaction.followUp(payload)
  }
  return interaction.reply(payload)
}

export function createRuntime({
  configStore,
  store,
  now = () => Date.now(),
  randomInt,
  fetchGuild,
  log = (message) => console.error(redact(message)),
  buttonLimiter = createRateLimiter({ limit: 5, windowMs: 10_000 }),
  lock = null,
}) {
  function held() {
    lock?.assertHeld?.()
  }
  let bound = null
  let timer = null
  let ticking = false
  const inflight = new Map()

  async function guildOf(guildId) {
    if (fetchGuild) return fetchGuild(guildId)
    if (!bound) throw new Error('Client is not ready.')
    return bound.guilds.fetch(guildId)
  }

  async function channelOf(giveaway) {
    const guild = await guildOf(giveaway.guildId)
    const channel = guild.channels.cache?.get(giveaway.channelId)
      ?? await guild.channels.fetch(giveaway.channelId)
    if (!channel?.isTextBased?.()) throw new Error('Giveaway channel is not a text channel.')
    return channel
  }

  async function loadMembers(giveaway) {
    const guild = await guildOf(giveaway.guildId)
    const map = new Map()
    for (const id of giveaway.entries) {
      try {
        const member = await guild.members.fetch(id)
        map.set(id, {
          id,
          bot: Boolean(member.user?.bot),
          roleIds: roleIdsOf(member),
          createdAt: member.user?.createdTimestamp ?? member.createdAt ?? 0,
        })
      } catch (error) {
        if (error?.code === 10007) continue
        throw error
      }
    }
    return map
  }

  async function botIdFor(giveaway) {
    const guild = await guildOf(giveaway.guildId)
    return guild.members?.me?.id ?? guild.client?.user?.id ?? null
  }

  async function locateAnnouncement(channel, giveaway, botId) {
    if (giveaway.messageId) return { found: true, messageId: giveaway.messageId, complete: true }
    if (!botId || typeof channel.messages?.fetch !== 'function') {
      throw new Error('Cannot reconcile the giveaway message without Read Message History.')
    }
    const pages = []
    let before
    for (let page = 0; page < HISTORY_PAGES; page += 1) {
      const batch = await channel.messages.fetch({ limit: HISTORY_PAGE, before })
      const list = [...(batch?.values?.() ?? batch ?? [])].map((message) => ({
        id: message.id,
        content: message.content,
        authorId: message.author?.id ?? message.authorId,
        createdTimestamp: message.createdTimestamp,
      }))
      pages.push(list)
      const scan = scanAnnouncementPages(pages, {
        id: giveaway.id,
        botId,
        createdAt: giveaway.createdAt,
      })
      if (scan.found || scan.complete) return scan
      if (!list.length) return { found: false, complete: true }
      before = list[list.length - 1].id
    }
    return scanAnnouncementPages(pages, {
      id: giveaway.id,
      botId,
      createdAt: giveaway.createdAt,
    })
  }

  async function remember(giveaway, messageId) {
    await store.update((data) => {
      const live = readGiveaway(data, giveaway.guildId, giveaway.id)
      if (live) rememberMessage(live, messageId)
    })
  }

  async function editAnnouncement(channel, messageId, payload) {
    if (typeof channel.messages?.edit === 'function') {
      await channel.messages.edit(messageId, payload)
      return
    }
    const message = await channel.messages.fetch(messageId)
    await message.edit(payload)
  }

  async function claimSend(giveaway) {
    return store.update((data) => {
      const live = readGiveaway(data, giveaway.guildId, giveaway.id)
      if (!live) return { ok: false, reason: 'missing' }
      if (live.messageId) return { ok: false, reason: 'sent', messageId: live.messageId }
      if (live.delivery === 'sending' || live.delivery === 'sent') return { ok: false, reason: 'attempted' }
      markSending(live)
      return { ok: true }
    })
  }

  async function publish(giveaway) {
    held()
    const channel = await channelOf(giveaway)
    const payload = payloadFor(giveaway)
    const botId = await botIdFor(giveaway)
    let messageId = giveaway.messageId
    let justSent = false
    if (!messageId) {
      const attempted = giveaway.delivery === 'sending' || giveaway.delivery === 'sent'
      let located = { found: false, complete: false }
      try {
        located = await locateAnnouncement(channel, giveaway, botId)
      } catch (error) {
        if (attempted) {
          throw new Error(`Giveaway history could not be checked after a send attempt: ${error.message}`)
        }
      }
      if (located.found) {
        messageId = located.messageId
        await remember(giveaway, messageId)
      } else if (attempted && !located.complete) {
        throw new Error('Giveaway history is incomplete after a send attempt, so another message was not sent.')
      } else {
        if (!String(payload.content).includes(announcementMarker(giveaway.id))) {
          throw new Error('Giveaway message is missing its id marker.')
        }
        if (!attempted) {
          const claim = await claimSend(giveaway)
          if (!claim.ok) {
            if (claim.messageId) messageId = claim.messageId
            else throw new Error('Giveaway send was already attempted. Not sending another copy until history shows the result.')
          }
        }
        if (!messageId) {
          held()
          const message = await channel.send({
            ...payload,
            nonce: giveawayNonce(giveaway.id),
            enforceNonce: true,
          })
          messageId = message.id
          justSent = true
          await remember(giveaway, messageId)
        }
      }
    }
    if (!justSent) {
      held()
      await editAnnouncement(channel, messageId, payload)
    }
    await store.update((data) => {
      const live = readGiveaway(data, giveaway.guildId, giveaway.id)
      if (!live) return
      const sameStatus = live.status === giveaway.status
      const sameWinners = JSON.stringify(live.winnerIds) === JSON.stringify(giveaway.winnerIds)
      const sameEntries = live.entries.length === giveaway.entries.length
      if (sameStatus && sameWinners && sameEntries) live.announcePending = false
    })
  }

  async function settleOnce(guildId, id) {
    held()
    const snapshot = await store.read()
    const current = readGiveaway(snapshot, guildId, id)
    if (!current) return { action: 'missing' }
    const time = now()
    if (current.status === 'open' && current.endAt <= time) {
      let membersById
      try {
        membersById = await loadMembers(current)
      } catch (error) {
        log(`Giveaway ${id} was not ended because member lookup failed: ${error.message}`)
        return { action: 'retry' }
      }
      const outcome = await store.update((data) => {
        const live = readGiveaway(data, guildId, id)
        if (!live || live.status !== 'open') {
          return { action: live?.announcePending ? 'announce' : 'none' }
        }
        planEnd(live, { now: time, membersById, randomInt })
        return { action: 'announce' }
      })
      if (outcome.action === 'announce') {
        const fresh = readGiveaway(await store.read(), guildId, id)
        await publish(fresh)
      }
      return outcome
    }
    if (current.announcePending) {
      await publish(current)
      return { action: 'announce' }
    }
    return { action: 'none' }
  }

  function settle(guildId, id) {
    const key = `${guildId}:${id}`
    const existing = inflight.get(key)
    if (existing) return existing
    const run = settleOnce(guildId, id).finally(() => {
      if (inflight.get(key) === run) inflight.delete(key)
    })
    inflight.set(key, run)
    return run
  }

  async function tick() {
    const data = await store.read()
    for (const item of dueIds(data, now())) {
      try {
        await settle(item.guildId, item.id)
      } catch (error) {
        log(`Giveaway ${item.id} announcement failed: ${error.message}`)
      }
    }
  }

  function kick() {
    if (ticking) return
    ticking = true
    tick().catch((error) => log(redact(error.message ?? error))).finally(() => {
      ticking = false
    })
  }

  function schedule() {
    clearInterval(timer)
    const seconds = configStore.get().schedulerIntervalSeconds
    timer = setInterval(kick, seconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function requireManager(interaction) {
    const options = guildOptions(configStore.get(), interaction.guild.id)
    if (!canManage(interaction.member, options.managerRoleId)) {
      await ephemeral(interaction, 'You need Manage Guild, or the configured manager role, to do that.')
      return null
    }
    return options
  }

  async function create(interaction) {
    const options = await requireManager(interaction)
    if (!options) return
    const prize = interaction.options.getString('prize', true)
    const minutes = interaction.options.getInteger('minutes', true)
    const winners = interaction.options.getInteger('winners', true)
    const channel = interaction.options.getChannel('channel', true)
    const requiredRole = interaction.options.getRole('required_role')
    if (!TEXT_CHANNELS.has(channel.type) || !channel.isTextBased?.()) {
      await ephemeral(interaction, 'Pick a text or announcement channel.')
      return
    }
    if (minutes > options.maxDurationMinutes) {
      await ephemeral(interaction, `That duration is above this server's max of ${options.maxDurationMinutes} minutes.`)
      return
    }
    if (winners > options.maxWinners) {
      await ephemeral(interaction, `That winner count is above this server's max of ${options.maxWinners}.`)
      return
    }
    const me = interaction.guild.members?.me
    const botPerms = channel.permissionsFor?.(me)
    if (!botPerms?.has(PermissionFlagsBits.ViewChannel) || !botPerms.has(PermissionFlagsBits.SendMessages)) {
      await ephemeral(interaction, 'I need View Channel and Send Messages in that channel.')
      return
    }
    const time = now()
    const id = newGiveawayId()
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    await store.update((data) => {
      insertGiveaway(data, {
        id,
        guildId: interaction.guild.id,
        channelId: channel.id,
        prize,
        winnerCount: winners,
        endAt: time + minutes * 60_000,
        createdBy: interaction.user.id,
        requiredRoleId: requiredRole?.id ?? null,
        minAccountAgeMs: options.minAccountAgeMs,
        now: time,
      })
    })
    try {
      await settle(interaction.guild.id, id)
    } catch (error) {
      log(`Giveaway ${id} was saved but not posted: ${error.message}`)
      await interaction.editReply(`Saved giveaway \`${id}\`, but the channel post failed. It will be retried while this process is running.`)
      return
    }
    await interaction.editReply(`Giveaway \`${id}\` is open. It ends in ${minutes} minute(s).`)
  }

  async function mutateManaged(interaction, verb) {
    const options = await requireManager(interaction)
    if (!options) return
    const id = interaction.options.getString('id', true)
    const existing = readGiveaway(await store.read(), interaction.guild.id, id)
    if (!existing) {
      await ephemeral(interaction, 'No giveaway with that id in this server.')
      return
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    if (verb === 'end') {
      await store.update((data) => {
        const live = readGiveaway(data, interaction.guild.id, id)
        if (live?.status === 'open') live.endAt = now()
      })
      const outcome = await settle(interaction.guild.id, id)
      const live = readGiveaway(await store.read(), interaction.guild.id, id)
      if (outcome.action === 'retry') {
        await interaction.editReply('The draw was not made because member lookup failed. Nothing was changed.')
        return
      }
      if (live?.status === 'ended') {
        const names = live.winnerIds.length ? live.winnerIds.map((userId) => `<@${userId}>`).join(', ') : 'nobody eligible'
        await interaction.editReply(`Giveaway \`${id}\` ended. Winners: ${names}.`)
        return
      }
      await interaction.editReply(`Giveaway \`${id}\` is ${live?.status ?? 'missing'}.`)
      return
    }
    if (verb === 'cancel') {
      const result = await store.update((data) => {
        const live = readGiveaway(data, interaction.guild.id, id)
        if (!live) return { ok: false, reason: 'missing' }
        return planCancel(live, now())
      })
      if (!result.ok) {
        await interaction.editReply(`That giveaway is already ${result.reason}.`)
        return
      }
      try {
        await settle(interaction.guild.id, id)
      } catch (error) {
        log(`Cancelled giveaway ${id} could not be edited: ${error.message}`)
      }
      await interaction.editReply(`Cancelled \`${id}\`. No winners were drawn.`)
      return
    }
    const result = await store.update((data) => {
      const live = readGiveaway(data, interaction.guild.id, id)
      if (!live) return { ok: false, reason: 'missing' }
      return planReroll(live, { interactionId: interaction.id, now: now(), randomInt })
    })
    if (!result.ok) {
      const text = result.reason === 'no_alternates'
        ? 'There is nobody left to draw who has not already won.'
        : 'Reroll only works after a giveaway has ended.'
      await interaction.editReply(text)
      return
    }
    try {
      await settle(interaction.guild.id, id)
    } catch (error) {
      log(`Reroll for ${id} could not be edited: ${error.message}`)
    }
    await interaction.editReply(`Rerolled \`${id}\`. Winners: ${result.winnerIds.map((userId) => `<@${userId}>`).join(', ')}.`)
  }

  async function press(interaction, kind, id) {
    const decision = buttonLimiter.take(`${interaction.guild.id}:${interaction.user.id}`)
    if (!decision.allowed) {
      await ephemeral(interaction, 'You are pressing that too quickly.')
      return
    }
    const existing = readGiveaway(await store.read(), interaction.guild.id, id)
    if (!existing) {
      await ephemeral(interaction, 'This giveaway is no longer active.')
      return
    }
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    }
    const person = personFrom(interaction)
    const result = await store.update((data) => {
      const live = readGiveaway(data, interaction.guild.id, id)
      if (!live) return { ok: false, reason: 'missing' }
      return kind === 'join' ? joinGiveaway(live, person, now()) : leaveGiveaway(live, person.id, now())
    })
    if (!result.ok) {
      const text = {
        duplicate: 'You are already entered.',
        absent: 'You are not entered.',
        closed: 'That giveaway is not open.',
        full: 'That giveaway is full.',
        bot: 'Bots cannot enter.',
        role: 'You do not have the required role.',
        age: 'Your account is too new for this giveaway.',
        left: 'You are not in this server.',
        missing: 'This giveaway is no longer active.',
      }[result.reason] ?? 'Could not update your entry.'
      await ephemeral(interaction, text)
      return
    }
    try {
      await settle(interaction.guild.id, id)
    } catch (error) {
      log(`Giveaway ${id} entry was saved but the post was not updated: ${error.message}`)
    }
    await ephemeral(interaction, kind === 'join'
      ? `You are entered (${result.count}).`
      : `You left (${result.count} still entered).`)
  }

  async function handleInteraction(interaction) {
    try {
      held()
      if (interaction.isChatInputCommand?.() && interaction.commandName === 'giveaway') {
        if (!interaction.inGuild()) {
          await ephemeral(interaction, 'This bot only works in servers.')
          return
        }
        const sub = interaction.options.getSubcommand()
        if (sub === 'create') {
          await create(interaction)
          return
        }
        if (sub === 'end' || sub === 'cancel' || sub === 'reroll') {
          await mutateManaged(interaction, sub)
        }
        return
      }
      if (!interaction.isButton?.()) return
      if (!interaction.inGuild()) {
        await ephemeral(interaction, 'This bot only works in servers.')
        return
      }
      const join = JOIN_ID.exec(interaction.customId ?? '')
      if (join) {
        await press(interaction, 'join', join[1])
        return
      }
      const leave = LEAVE_ID.exec(interaction.customId ?? '')
      if (leave) {
        await press(interaction, 'leave', leave[1])
        return
      }
      if (String(interaction.customId ?? '').startsWith('gw:')) {
        await ephemeral(interaction, 'This button is out of date.')
      }
    } catch (error) {
      log(redact(error instanceof Error ? error.message : error))
      if (error?.code === 'LEASE_LOST') return
      await ephemeral(interaction, 'Command failed.').catch(() => {})
    }
  }

  return {
    guildOptions,
    handleInteraction,
    tick,
    settle,
    bind(client) {
      bound = client
      client.on(Events.InteractionCreate, (interaction) => {
        handleInteraction(interaction).catch((error) => log(redact(error.message ?? error)))
      })
      client.once(Events.ClientReady, (ready) => {
        console.log(`Logged in as ${ready.user?.tag ?? 'bot'}`)
        const clientId = process.env.CLIENT_ID?.trim()
        if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
        kick()
        schedule()
      })
      configStore.onReload(() => {
        if (timer) schedule()
      })
    },
    shutdown() {
      clearInterval(timer)
      timer = null
    },
  }
}
