import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { commandDenial, DEFAULT_DJ_ONLY, hasManageGuild, isDjCommand } from './access.js'
import { redact } from './env.js'
import { publicMessage } from './errors.js'
import { UserError } from './errors.js'
import { formatQueue, safeLabel } from './queue.js'
import { BUTTON_COMMAND, buildSearchMessage, SAFE_MENTIONS } from './nowplaying.js'
import { guildSettings, patchGuild } from './settings.js'
import { interpretQuery } from './sources.js'

const CONTROL = new Set([
  'pause', 'resume', 'skip', 'back', 'replay', 'stop', 'volume', 'seek', 'forward', 'rewind', 'filter',
])

function ephemeral(interaction, content) {
  const payload = { content: String(content).slice(0, 2000), flags: MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS }
  if (interaction.deferred && interaction.isChatInputCommand?.()) {
    return interaction.editReply({ content: payload.content, allowedMentions: SAFE_MENTIONS })
  }
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload)
  return interaction.reply(payload)
}

async function ack(interaction) {
  if (interaction.deferred || interaction.replied) return
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    await interaction.deferUpdate()
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS })
}

function settingsOf(interaction, ctx) {
  return guildSettings(ctx.configStore.get(), interaction.guildId)
}

function gate(interaction, ctx, command, { voiceId = null, configuring = false } = {}) {
  return commandDenial({
    command,
    member: interaction.member,
    channelId: interaction.channelId,
    voiceChannelId: voiceId,
    settings: settingsOf(interaction, ctx),
    configuring,
  })
}

function voiceChannel(interaction) {
  const channel = interaction.member?.voice?.channel ?? null
  if (!channel || channel.type !== ChannelType.GuildVoice) return null
  return channel
}

function canSpeak(channel, interaction) {
  const me = interaction.guild?.members?.me
  const perms = me ? channel.permissionsFor?.(me) : null
  return Boolean(perms?.has(PermissionFlagsBits.Connect) && perms.has(PermissionFlagsBits.Speak))
}

function sameVoice(interaction) {
  const bot = interaction.guild?.members?.me?.voice?.channelId ?? null
  const user = interaction.member?.voice?.channelId ?? null
  if (!bot) return 'Nothing is playing.'
  if (user !== bot) return 'Join the voice channel the bot is in first.'
  return null
}

function otherVoice(interaction, channel) {
  const bot = interaction.guild?.members?.me?.voice?.channelId ?? null
  if (bot && bot !== channel.id) return 'I am already playing in another voice channel.'
  return null
}

function decorate(track, user) {
  return {
    kind: track.kind,
    title: track.title || track.url,
    url: track.url,
    durationMs: track.durationMs ?? null,
    soundcloudId: track.soundcloudId ?? null,
    artworkUrl: track.artworkUrl ?? null,
    requestedById: user.id,
    requestedByTag: user.username || user.tag || user.id,
  }
}

function playerChannel(interaction, ctx) {
  return settingsOf(interaction, ctx).requestChannelId || interaction.channelId
}

async function plannedTracks(interpreted, interaction, ctx) {
  if (interpreted.mode === 'search') {
    const found = await ctx.sources.search(interpreted.query, { limit: 1 })
    if (!found?.length) throw new UserError('No SoundCloud track matched that name.')
    return found.slice(0, 1)
  }
  if (interpreted.classified.kind === 'soundcloud') {
    const settings = settingsOf(interaction, ctx)
    return ctx.sources.expand(interpreted.classified.url, settings.maxQueueSize)
  }
  return [interpreted.classified]
}

async function playCommand(interaction, ctx, placement) {
  const command = placement === 'now' ? 'playskip' : placement === 'next' ? 'playtop' : 'play'
  const channel = voiceChannel(interaction)
  const denial = gate(interaction, ctx, command, { voiceId: channel?.id ?? null })
  if (denial) return ephemeral(interaction, denial)
  let interpreted
  try {
    interpreted = interpretQuery(interaction.options.getString('query'), {
      attachment: interaction.options.getAttachment('file'),
      kind: interaction.options.getString('kind') ?? 'auto',
    })
  } catch (error) {
    return ephemeral(interaction, publicMessage(error))
  }
  if (!channel) return ephemeral(interaction, 'Join a voice channel first. Stage channels are not supported.')
  if (!canSpeak(channel, interaction)) return ephemeral(interaction, 'I need Connect and Speak in that voice channel.')
  const busy = otherVoice(interaction, channel)
  if (busy) return ephemeral(interaction, busy)
  await ack(interaction)
  const tracks = (await plannedTracks(interpreted, interaction, ctx)).map((track) => decorate(track, interaction.user))
  ctx.music.bindText(interaction.guildId, playerChannel(interaction, ctx))
  const result = await ctx.music.play(interaction.guildId, channel, tracks, placement)
  return ephemeral(interaction, result.message)
}

async function searchCommand(interaction, ctx) {
  const denial = gate(interaction, ctx, 'search')
  if (denial) return ephemeral(interaction, denial)
  const query = interaction.options.getString('query', true)
  await ack(interaction)
  const tracks = await ctx.sources.search(query, { limit: 10 })
  if (!tracks?.length) return ephemeral(interaction, 'No SoundCloud track matched that name.')
  const token = ctx.searches.put(interaction.guildId, interaction.user.id, tracks)
  return interaction.editReply(buildSearchMessage(token, tracks))
}

async function selectCommand(interaction, ctx) {
  if (!String(interaction.customId ?? '').startsWith('ck:pick:')) return
  const channel = voiceChannel(interaction)
  const denial = gate(interaction, ctx, 'play', { voiceId: channel?.id ?? null })
  if (denial) return ephemeral(interaction, denial)
  if (!channel) return ephemeral(interaction, 'Join a voice channel first. Stage channels are not supported.')
  if (!canSpeak(channel, interaction)) return ephemeral(interaction, 'I need Connect and Speak in that voice channel.')
  const busy = otherVoice(interaction, channel)
  if (busy) return ephemeral(interaction, busy)
  await ack(interaction)
  const token = String(interaction.customId).slice('ck:pick:'.length)
  const picked = ctx.searches.take(token, { guildId: interaction.guildId, userId: interaction.user.id })
  if (picked.error === 'owner') return ephemeral(interaction, 'That search belongs to someone else.')
  if (picked.error) return ephemeral(interaction, 'That search expired. Run /search again.')
  const track = picked.tracks[Number(interaction.values?.[0])]
  if (!track) return ephemeral(interaction, 'That choice is no longer available.')
  ctx.music.bindText(interaction.guildId, playerChannel(interaction, ctx))
  const result = await ctx.music.play(interaction.guildId, channel, [decorate(track, interaction.user)])
  return ephemeral(interaction, result.message)
}

async function buttonCommand(interaction, ctx) {
  const command = BUTTON_COMMAND[interaction.customId]
  if (!command) return
  const denial = gate(interaction, ctx, command, { voiceId: interaction.member?.voice?.channelId ?? null })
  if (denial) return ephemeral(interaction, denial)
  if (command !== 'loop' && command !== 'shuffle') {
    const where = sameVoice(interaction)
    if (where) return ephemeral(interaction, where)
  }
  await ack(interaction)
  const guildId = interaction.guildId
  let result
  if (command === 'pause') result = await ctx.music.pause(guildId)
  else if (command === 'resume') result = await ctx.music.resume(guildId)
  else if (command === 'skip') result = await ctx.music.skip(guildId)
  else if (command === 'back') result = await ctx.music.back(guildId)
  else if (command === 'stop') result = await ctx.music.stop(guildId)
  else if (command === 'loop') result = ctx.music.cycleLoopMode(guildId)
  else if (command === 'shuffle') result = ctx.music.shuffle(guildId)
  else return
  return ephemeral(interaction, result.message)
}

function requireManager(interaction) {
  if (!hasManageGuild(interaction.member)) return 'Manage Server is required for that.'
  return null
}

async function setupCommand(interaction, ctx) {
  const managerError = requireManager(interaction)
  if (managerError) return ephemeral(interaction, managerError)
  if (!ctx.requestChannelEnabled) {
    return ephemeral(
      interaction,
      'Song requests are off. Set ENABLE_REQUEST_CHANNEL=1 and enable the Message Content intent in the Developer Portal, then restart.',
    )
  }
  if (interaction.options.getBoolean('disable')) {
    await ack(interaction)
    patchGuild(ctx.configStore, interaction.guildId, {
      requestChannelId: null,
      requestAutoDelete: null,
      requestCommandsOnly: null,
    })
    return ephemeral(interaction, 'Song request channel cleared.')
  }
  const channel = interaction.options.getChannel('channel')
  if (!channel || channel.type !== ChannelType.GuildText) {
    return ephemeral(interaction, 'Choose a text channel, or set disable to true.')
  }
  await ack(interaction)
  patchGuild(ctx.configStore, interaction.guildId, {
    requestChannelId: channel.id,
    requestAutoDelete: interaction.options.getBoolean('autodelete') ?? false,
    requestCommandsOnly: interaction.options.getBoolean('commandsonly') ?? false,
  })
  return ephemeral(interaction, 'Song request channel saved. Members can type a name or a URL there.')
}

async function setDj(interaction, ctx) {
  const managerError = requireManager(interaction)
  if (managerError) return ephemeral(interaction, managerError)
  await ack(interaction)
  const role = interaction.options.getRole('role')
  const current = settingsOf(interaction, ctx)
  if (!role) {
    patchGuild(ctx.configStore, interaction.guildId, { djRoleId: null })
    return ephemeral(interaction, 'DJ role cleared.')
  }
  patchGuild(ctx.configStore, interaction.guildId, {
    djRoleId: role.id,
    djOnly: current.djOnly.length > 0 ? current.djOnly : DEFAULT_DJ_ONLY,
  })
  return ephemeral(interaction, `DJ role set. Control commands now require ${safeLabel(role.name, 80)} until you change the list.`)
}

async function setDjOnly(interaction, ctx) {
  const managerError = requireManager(interaction)
  if (managerError) return ephemeral(interaction, managerError)
  const sub = interaction.options.getSubcommand()
  const current = settingsOf(interaction, ctx)
  if (sub === 'list') {
    const list = current.djOnly.length > 0 ? current.djOnly.join(', ') : 'none'
    return ephemeral(interaction, `DJ-only commands: ${list}`)
  }
  const name = interaction.options.getString('command', true).trim().toLowerCase()
  if (!isDjCommand(name)) return ephemeral(interaction, 'That command cannot be marked DJ-only.')
  await ack(interaction)
  const next = new Set(current.djOnly)
  if (sub === 'add') next.add(name)
  if (sub === 'remove') next.delete(name)
  patchGuild(ctx.configStore, interaction.guildId, { djOnly: [...next] })
  return ephemeral(interaction, sub === 'add' ? `${name} now requires the DJ role.` : `${name} no longer requires the DJ role.`)
}

function toggleList(interaction, ctx, keyLock, keyList) {
  const managerError = requireManager(interaction)
  if (managerError) return managerError
  const action = interaction.options.getString('action', true)
  const channel = interaction.options.getChannel('channel')
  const current = settingsOf(interaction, ctx)
  const list = new Set(current[keyList])
  if ((action === 'allow' || action === 'deny') && !channel) return 'Choose a channel.'
  if (action === 'allow') list.add(channel.id)
  if (action === 'deny') list.delete(channel.id)
  const enabled = action === 'disable' ? false : action === 'enable' || action === 'allow' ? true : current[keyLock]
  patchGuild(ctx.configStore, interaction.guildId, {
    [keyLock]: enabled,
    [keyList]: [...list],
  })
  return enabled
    ? `Restriction on. ${list.size} channel(s) allowed.`
    : 'Restriction off.'
}

async function playlistCommand(interaction, ctx) {
  const denial = gate(interaction, ctx, 'playlist')
  if (denial) return ephemeral(interaction, denial)
  const sub = interaction.options.getSubcommand()
  const manage = hasManageGuild(interaction.member)
  const guildId = interaction.guildId
  const userId = interaction.user.id
  if (sub === 'show' && !interaction.options.getString('name')) {
    const lines = ctx.playlists.list(guildId).map((entry) => `${entry.name} (${entry.tracks})`)
    return ephemeral(interaction, lines.length > 0 ? lines.join('\n').slice(0, 1900) : 'No playlists on this server.')
  }
  const name = interaction.options.getString('name')
  if (sub === 'create') {
    await ack(interaction)
    const saved = await ctx.playlists.create(guildId, userId, name)
    return ephemeral(interaction, `Created playlist ${saved}.`)
  }
  if (sub === 'show') {
    const entry = ctx.playlists.show(guildId, name)
    const lines = entry.tracks.slice(0, 15).map((track, index) => `${index + 1}. ${track.title}`)
    const extra = entry.tracks.length > 15 ? `\n…and ${entry.tracks.length - 15} more` : ''
    const mode = entry.readOnly ? 'read-only import' : 'editable'
    return ephemeral(interaction, `${entry.name} (${mode}, ${entry.tracks.length})\n${lines.join('\n')}${extra}`.slice(0, 1900))
  }
  if (sub === 'delete') {
    await ack(interaction)
    await ctx.playlists.delete(guildId, userId, manage, name)
    return ephemeral(interaction, `Deleted playlist ${name}.`)
  }
  if (sub === 'remove') {
    await ack(interaction)
    const title = await ctx.playlists.remove(guildId, userId, manage, name, interaction.options.getInteger('index', true))
    return ephemeral(interaction, `Removed ${title}.`)
  }
  if (sub === 'share') {
    await ack(interaction)
    const code = await ctx.playlists.share(guildId, userId, manage, name)
    return ephemeral(interaction, `Share code: ${code}. Another server can import it as a read-only snapshot.`)
  }
  if (sub === 'import') {
    await ack(interaction)
    const saved = await ctx.playlists.importCode(guildId, userId, interaction.options.getString('code', true), name)
    return ephemeral(interaction, `Imported ${saved} as a read-only playlist.`)
  }
  if (sub === 'add' || sub === 'addtrack' || sub === 'addqueue') {
    await ack(interaction)
    let tracks = []
    if (sub === 'add') {
      const interpreted = interpretQuery(interaction.options.getString('query', true))
      const planned = await plannedTracks(interpreted, interaction, ctx)
      tracks = planned.map((track) => decorate(track, interaction.user))
    } else {
      const queue = ctx.music.snapshot(guildId)
      const live = [queue.current, ...queue.tracks].filter(Boolean)
      if (live.length === 0) return ephemeral(interaction, 'Nothing is queued.')
      tracks = sub === 'addtrack' ? [live[0]] : live
    }
    const result = await ctx.playlists.addTracks(guildId, userId, manage, name, tracks)
    const extra = result.rejected > 0 ? ` ${result.rejected} did not fit.` : ''
    return ephemeral(interaction, `Added ${result.added} track(s).${extra}`)
  }
  if (sub === 'play') {
    const channel = voiceChannel(interaction)
    const voiceDenial = gate(interaction, ctx, 'playlist', { voiceId: channel?.id ?? null })
    if (voiceDenial) return ephemeral(interaction, voiceDenial)
    if (!channel) return ephemeral(interaction, 'Join a voice channel first. Stage channels are not supported.')
    if (!canSpeak(channel, interaction)) return ephemeral(interaction, 'I need Connect and Speak in that voice channel.')
    const busy = otherVoice(interaction, channel)
    if (busy) return ephemeral(interaction, busy)
    await ack(interaction)
    const entry = ctx.playlists.show(guildId, name)
    if (entry.tracks.length === 0) return ephemeral(interaction, 'That playlist is empty.')
    ctx.music.bindText(guildId, playerChannel(interaction, ctx))
    const result = await ctx.music.play(guildId, channel, entry.tracks.map((track) => decorate(track, interaction.user)))
    return ephemeral(interaction, result.message)
  }
  return ephemeral(interaction, 'Unknown playlist action.')
}

async function settingsCommand(interaction, ctx) {
  const volume = interaction.options.getInteger('volume')
  const queue = interaction.options.getInteger('queue')
  const autoplay = interaction.options.getBoolean('autoplay')
  const filter = interaction.options.getString('filter')
  const mutating = volume != null || queue != null || autoplay != null || filter != null
  if (mutating && !hasManageGuild(interaction.member)) {
    return ephemeral(interaction, 'Manage Server is required to change settings.')
  }
  const denial = gate(interaction, ctx, 'settings', { configuring: true })
  if (denial) return ephemeral(interaction, denial)
  if (mutating) {
    await ack(interaction)
    patchGuild(ctx.configStore, interaction.guildId, {
      ...(volume != null ? { defaultVolume: volume } : {}),
      ...(queue != null ? { maxQueueSize: queue } : {}),
      ...(autoplay != null ? { autoplay } : {}),
      ...(filter != null ? { filter } : {}),
    })
  }
  const next = settingsOf(interaction, ctx)
  const text = [
    `Volume default: ${next.defaultVolume}%`,
    `Queue limit: ${next.maxQueueSize}`,
    `Autoplay: ${next.autoplay ? 'on' : 'off'}`,
    `Filter: ${next.filter}`,
    `24/7: ${next.stayConnected ? 'on' : 'off'}`,
    `DJ role: ${next.djRoleId ?? 'none'}`,
    `Request channel: ${next.requestChannelId ?? 'none'}`,
  ].join('\n')
  return ephemeral(interaction, text)
}

async function routeCommand(interaction, ctx) {
  const name = interaction.commandName
  if (name === 'play') return playCommand(interaction, ctx, 'end')
  if (name === 'playskip') return playCommand(interaction, ctx, 'now')
  if (name === 'playtop') return playCommand(interaction, ctx, 'next')
  if (name === 'search') return searchCommand(interaction, ctx)
  if (name === 'queue') return ephemeral(interaction, formatQueue(ctx.music.snapshot(interaction.guildId)))
  if (name === 'nowplaying') {
    ctx.music.bindText(interaction.guildId, playerChannel(interaction, ctx))
    await ack(interaction)
    return interaction.editReply(ctx.music.refresh(interaction.guildId))
  }
  if (name === 'ping') {
    const ping = interaction.client?.ws?.ping
    const text = Number.isFinite(ping) && ping >= 0 ? `Gateway ping: ${Math.round(ping)}ms.` : 'Gateway ping is not ready.'
    return ephemeral(interaction, text)
  }
  if (name === 'settings') return settingsCommand(interaction, ctx)
  if (name === 'setup') return setupCommand(interaction, ctx)
  if (name === 'setdj') return setDj(interaction, ctx)
  if (name === 'setdjonly') return setDjOnly(interaction, ctx)
  if (name === 'texttoggle' || name === 'voicetoggle') {
    const message = name === 'texttoggle'
      ? toggleList(interaction, ctx, 'textLock', 'textChannels')
      : toggleList(interaction, ctx, 'voiceLock', 'voiceChannels')
    return ephemeral(interaction, message)
  }
  if (name === 'playlist') return playlistCommand(interaction, ctx)
  if (name === 'stay') {
    const managerError = requireManager(interaction)
    if (managerError) return ephemeral(interaction, managerError)
    const enabled = interaction.options.getBoolean('enabled', true)
    const channel = voiceChannel(interaction)
    if (enabled && !channel) return ephemeral(interaction, 'Join a voice channel first. Stage channels are not supported.')
    if (enabled && channel) {
      const denial = gate(interaction, ctx, 'stay', { voiceId: channel.id, configuring: true })
      if (denial) return ephemeral(interaction, denial)
    }
    await ack(interaction)
    ctx.music.bindText(interaction.guildId, playerChannel(interaction, ctx))
    const result = await ctx.music.stay(interaction.guildId, enabled, channel)
    return ephemeral(interaction, result.message)
  }
  if (CONTROL.has(name) || name === 'leave' || name === 'join' || name === 'sleep' || name === 'loop' || name === 'shuffle' || name === 'move' || name === 'remove' || name === 'clear') {
    const voiceId = name === 'join' ? voiceChannel(interaction)?.id ?? null : interaction.member?.voice?.channelId ?? null
    const denial = gate(interaction, ctx, name, { voiceId })
    if (denial) return ephemeral(interaction, denial)
    if (!['loop', 'shuffle', 'join'].includes(name)) {
      const where = sameVoice(interaction)
      if (where) return ephemeral(interaction, where)
    }
    if (name === 'join') {
      const channel = voiceChannel(interaction)
      if (!channel) return ephemeral(interaction, 'Join a voice channel first. Stage channels are not supported.')
      if (!canSpeak(channel, interaction)) return ephemeral(interaction, 'I need Connect and Speak in that voice channel.')
      await ack(interaction)
      ctx.music.bindText(interaction.guildId, playerChannel(interaction, ctx))
      return ephemeral(interaction, (await ctx.music.join(interaction.guildId, channel)).message)
    }
    await ack(interaction)
    const guildId = interaction.guildId
    if (name === 'pause') return ephemeral(interaction, (await ctx.music.pause(guildId)).message)
    if (name === 'resume') return ephemeral(interaction, (await ctx.music.resume(guildId)).message)
    if (name === 'skip') return ephemeral(interaction, (await ctx.music.skip(guildId)).message)
    if (name === 'back') return ephemeral(interaction, (await ctx.music.back(guildId)).message)
    if (name === 'replay') return ephemeral(interaction, (await ctx.music.replay(guildId)).message)
    if (name === 'stop') return ephemeral(interaction, (await ctx.music.stop(guildId)).message)
    if (name === 'leave') return ephemeral(interaction, (await ctx.music.leave(guildId)).message)
    if (name === 'volume') return ephemeral(interaction, ctx.music.setGuildVolume(guildId, interaction.options.getInteger('level', true)).message)
    if (name === 'seek') return ephemeral(interaction, (await ctx.music.seek(guildId, interaction.options.getInteger('seconds', true))).message)
    if (name === 'forward') return ephemeral(interaction, (await ctx.music.nudge(guildId, interaction.options.getInteger('seconds') ?? 10)).message)
    if (name === 'rewind') return ephemeral(interaction, (await ctx.music.nudge(guildId, -(interaction.options.getInteger('seconds') ?? 10))).message)
    if (name === 'filter') return ephemeral(interaction, (await ctx.music.setFilter(guildId, interaction.options.getString('preset', true))).message)
    if (name === 'loop') return ephemeral(interaction, ctx.music.setLoopMode(guildId, interaction.options.getString('mode', true)).message)
    if (name === 'shuffle') return ephemeral(interaction, ctx.music.shuffle(guildId).message)
    if (name === 'move') {
      return ephemeral(interaction, ctx.music.move(guildId, interaction.options.getInteger('from', true), interaction.options.getInteger('to', true)).message)
    }
    if (name === 'remove') return ephemeral(interaction, ctx.music.remove(guildId, interaction.options.getInteger('index', true)).message)
    if (name === 'clear') return ephemeral(interaction, ctx.music.clear(guildId).message)
    if (name === 'sleep') return ephemeral(interaction, ctx.music.sleep(guildId, interaction.options.getInteger('minutes', true)).message)
  }
  return null
}

export async function handleInteraction(interaction, ctx) {
  try {
    if (!interaction.inGuild?.()) {
      if (interaction.isRepliable?.()) return ephemeral(interaction, 'This bot only works in servers.')
      return null
    }
    if (interaction.isButton?.()) return await buttonCommand(interaction, ctx)
    if (interaction.isStringSelectMenu?.()) return await selectCommand(interaction, ctx)
    if (!interaction.isChatInputCommand?.()) return null
    return await routeCommand(interaction, ctx)
  } catch (error) {
    console.error(redact(error?.stack || error?.message || error))
    return ephemeral(interaction, publicMessage(error))
  }
}
