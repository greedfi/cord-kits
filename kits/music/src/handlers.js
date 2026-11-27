import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { authorize, commandForButton, voiceAllowed } from './access.js'
import { CONFIG_COMMANDS, FILTER_IDS, LOOP_MODES } from './catalog.js'
import { redact } from './env.js'
import { nowPlayingPayload, SAFE_MENTIONS, searchMenu } from './nowplaying.js'
import { formatQueue, parseClock, safeLabel } from './queue.js'
import { resolveTracks as defaultResolveTracks } from './resolve.js'
import { guildSettings, waitingLimit } from './settings.js'
import { SourceError } from './sources.js'

const SEARCH_TTL_MS = 5 * 60 * 1000
const CONFIG = new Set(CONFIG_COMMANDS)
const NEEDS_USER_VOICE = new Set(['play', 'playskip', 'playtop', 'search', 'join'])
const NEEDS_SAME_VOICE = new Set([
  'pause', 'resume', 'skip', 'back', 'replay', 'stop', 'loop', 'shuffle', 'move',
  'remove', 'clear', 'seek', 'forward', 'rewind', 'volume', 'leave', 'sleep',
])
const LOCKED = new Set([
  'play', 'playskip', 'playtop', 'search', 'pause', 'resume', 'skip', 'back',
  'replay', 'stop', 'loop', 'shuffle', 'move', 'remove', 'clear', 'seek',
  'forward', 'rewind', 'volume', 'join', 'leave', 'sleep', 'filter', 'playlist',
])
const PLACEMENTS = { play: 'end', playskip: 'skip', playtop: 'top' }
const PLAYLIST_ERRORS = {
  bad_name: 'Playlist names are 1-32 characters and cannot include mentions.',
  too_many: 'This server already has 25 playlists.',
  exists: 'A playlist with that name already exists.',
  missing: 'No playlist with that name is on this server.',
  readonly: 'Imported playlists are read-only.',
  forbidden: 'Only the owner or a manager can change that playlist.',
  full: 'That playlist already has 100 tracks.',
  bad_index: 'That track number is outside the playlist.',
  same_guild: 'That share code belongs to a playlist already on this server.',
}

function logError(error) {
  const text = error instanceof Error ? error.stack ?? error.message : error
  console.error(redact(text))
}

function publicError(error) {
  if (!(error instanceof Error)) return 'Command failed.'
  if (/https?:|client_id=|DISCORD_BOT_TOKEN/i.test(error.message)) return 'Command failed.'
  return error.message
}

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral, allowedMentions: SAFE_MENTIONS }
}

async function finish(interaction, content) {
  const payload = { content, allowedMentions: SAFE_MENTIONS }
  if (interaction.deferred && !interaction.replied) return interaction.editReply(payload)
  if (interaction.replied || interaction.deferred) return interaction.followUp(ephemeral(content))
  return interaction.reply(ephemeral(content))
}

async function present(interaction, payload) {
  const body = { allowedMentions: SAFE_MENTIONS, ...payload }
  if (interaction.deferred || interaction.replied) return interaction.editReply(body)
  return interaction.reply(body)
}

function tagTracks(tracks, user) {
  return tracks.map((track) => ({
    kind: track.kind,
    title: track.title || track.url,
    url: track.url,
    durationMs: track.durationMs ?? null,
    soundcloudId: track.soundcloudId ?? null,
    artist: track.artist ?? null,
    requestedById: user.id,
    requestedByTag: user.username || 'someone',
  }))
}

function userVoice(interaction) {
  return interaction.member?.voice?.channel ?? null
}

function botVoiceId(interaction) {
  return interaction.guild?.members?.me?.voice?.channelId ?? null
}

function checkVoice(commandName, interaction, settings) {
  if (CONFIG.has(commandName)) return null
  const voice = userVoice(interaction)
  if (voice && !voiceAllowed(settings, voice.id)) return 'That voice channel is not allowed.'
  if (NEEDS_USER_VOICE.has(commandName)) {
    if (!voice || voice.type === ChannelType.GuildStageVoice) {
      return 'Join a voice channel first. Stage channels are not supported.'
    }
    const botChannel = botVoiceId(interaction)
    if (commandName !== 'join' && botChannel && botChannel !== voice.id) {
      return 'I am already playing in another voice channel.'
    }
    const permissions = voice.permissionsFor?.(interaction.guild.members.me)
    if (
      permissions
      && (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak))
    ) {
      return 'I need Connect and Speak in that voice channel.'
    }
  }
  if (commandName === 'filter') {
    const botChannel = botVoiceId(interaction)
    if (botChannel && voice?.id !== botChannel) return 'Join the voice channel the bot is in first.'
    return null
  }
  if (NEEDS_SAME_VOICE.has(commandName)) {
    const botChannel = botVoiceId(interaction)
    if (!botChannel) return 'Nothing is playing.'
    if (!voice || voice.id !== botChannel) return 'Join the voice channel the bot is in first.'
  }
  return null
}

export function createApp(deps) {
  const resolveTracks = deps.resolveTracks ?? defaultResolveTracks
  const now = deps.now ?? (() => Date.now())
  const searches = new Map()

  function settingsFor(guildId) {
    return guildSettings(deps.config.get(), guildId)
  }

  function writeGuild(guildId, patch) {
    deps.config.update((draft) => {
      draft.guilds[guildId] = { ...draft.guilds[guildId], ...patch }
    })
  }

  function rememberSearch(guildId, userId, results) {
    const stamp = now()
    for (const [key, value] of searches) {
      if (stamp - value.at > SEARCH_TTL_MS) searches.delete(key)
    }
    searches.set(`${guildId}:${userId}`, { results, at: stamp })
  }

  async function showSavedPanel(guild, guildId) {
    const settings = settingsFor(guildId)
    if (!deps.requestChannel || !settings.requestChannelId || !deps.panels) return false
    const channel = guild.channels.cache?.get?.(settings.requestChannelId)
      ?? await guild.channels.fetch(settings.requestChannelId)
    if (!channel) return false
    await deps.panels.show(guildId, channel, nowPlayingPayload(deps.music.snapshot(guildId), now()))
    deps.progress?.mark(guildId)
    return true
  }

  async function replyWithPlayer(interaction, guildId, text) {
    const saved = await showSavedPanel(interaction.guild, guildId)
    if (saved) {
      await present(interaction, { content: text })
      return
    }
    const body = nowPlayingPayload(deps.music.snapshot(guildId), now())
    await present(interaction, body)
    if (!interaction.fetchReply || !deps.panels) {
      deps.progress?.mark(guildId)
      return
    }
    const message = await interaction.fetchReply()
    await deps.panels.save(guildId, { channelId: message.channelId, messageId: message.id })
    deps.progress?.mark(guildId)
  }

  async function playResolved(interaction, placement) {
    const settings = settingsFor(interaction.guildId)
    const tracks = await resolveTracks({
      query: interaction.options.getString('query'),
      attachment: interaction.options.getAttachment('file'),
      kind: interaction.options.getString('kind') ?? 'auto',
      mode: 'play',
      limit: waitingLimit(settings),
    })
    const result = await deps.music.play(
      interaction.guildId,
      userVoice(interaction),
      tagTracks(tracks, interaction.user),
      placement,
    )
    if (!result.ok) {
      await present(interaction, { content: result.message })
      return
    }
    await replyWithPlayer(interaction, interaction.guildId, result.message)
  }

  async function onPlaylist(interaction) {
    const sub = interaction.options.getSubcommand()
    const name = interaction.options.getString('name')
    const actorId = interaction.user.id
    const manage = authorize({
      commandName: 'settings',
      settings: settingsFor(interaction.guildId),
      member: interaction.member,
      channelId: interaction.channelId,
      requestChannelActive: false,
    }) == null
    const store = deps.playlists
    if (sub === 'create') {
      const result = store.create({ guildId: interaction.guildId, ownerId: actorId, name })
      await present(interaction, { content: result.ok ? `Created **${safeLabel(result.playlist.name)}**.` : PLAYLIST_ERRORS[result.error] })
      return
    }
    if (sub === 'import') {
      const result = store.importCode({
        guildId: interaction.guildId,
        ownerId: actorId,
        code: interaction.options.getString('code', true).trim(),
      })
      await present(interaction, {
        content: result.ok
          ? `Imported **${safeLabel(result.playlist.name)}** as a read-only playlist.`
          : PLAYLIST_ERRORS[result.error],
      })
      return
    }
    if (sub === 'show') {
      const playlist = store.find(interaction.guildId, name)
      if (!playlist) {
        await present(interaction, { content: PLAYLIST_ERRORS.missing })
        return
      }
      const lines = [`**${safeLabel(playlist.name)}** (${playlist.tracks.length} tracks${playlist.imported ? ', read-only' : ''})`]
      playlist.tracks.slice(0, 15).forEach((track, index) => {
        lines.push(`${index + 1}. ${safeLabel(track.title || track.url)}`)
      })
      if (playlist.tracks.length > 15) lines.push(`…and ${playlist.tracks.length - 15} more`)
      await present(interaction, { content: lines.join('\n').slice(0, 2000) })
      return
    }
    if (sub === 'delete') {
      const result = store.delete({ guildId: interaction.guildId, actorId, manage, name })
      await present(interaction, { content: result.ok ? 'Deleted that playlist.' : PLAYLIST_ERRORS[result.error] })
      return
    }
    if (sub === 'share') {
      const result = store.share({ guildId: interaction.guildId, actorId, manage, name })
      await present(interaction, {
        content: result.ok ? `Share code: ${result.shareCode}` : PLAYLIST_ERRORS[result.error],
      })
      return
    }
    if (sub === 'remove') {
      const result = store.removeTrack({
        guildId: interaction.guildId,
        actorId,
        manage,
        name,
        index: interaction.options.getInteger('index', true),
      })
      await present(interaction, { content: result.ok ? 'Removed that track.' : PLAYLIST_ERRORS[result.error] })
      return
    }
    if (sub === 'add' || sub === 'addtrack') {
      const tracks = await resolveTracks({
        query: interaction.options.getString('query', true),
        mode: sub === 'addtrack' ? 'one' : 'play',
        limit: 100,
      })
      const result = store.addTracks({
        guildId: interaction.guildId,
        actorId,
        manage,
        name,
        tracks,
      })
      if (!result.ok) {
        await present(interaction, { content: PLAYLIST_ERRORS[result.error] })
        return
      }
      let text = `Added ${result.accepted.length} track${result.accepted.length === 1 ? '' : 's'}.`
      if (result.rejected > 0) text += ` ${result.rejected} did not fit.`
      await present(interaction, { content: text })
      return
    }
    if (sub === 'addqueue') {
      const snapshot = deps.music.snapshot(interaction.guildId)
      const tracks = [...(snapshot.current ? [snapshot.current] : []), ...snapshot.tracks]
      if (tracks.length === 0) {
        await present(interaction, { content: 'Nothing is queued.' })
        return
      }
      const result = store.addTracks({ guildId: interaction.guildId, actorId, manage, name, tracks })
      await present(interaction, {
        content: result.ok
          ? `Added ${result.accepted.length} track${result.accepted.length === 1 ? '' : 's'}.`
          : PLAYLIST_ERRORS[result.error],
      })
      return
    }
    const playlist = store.find(interaction.guildId, name)
    if (!playlist) {
      await present(interaction, { content: PLAYLIST_ERRORS.missing })
      return
    }
    if (playlist.tracks.length === 0) {
      await present(interaction, { content: 'That playlist is empty.' })
      return
    }
    const voiceError = checkVoice('play', interaction, settingsFor(interaction.guildId))
    if (voiceError) {
      await present(interaction, { content: voiceError })
      return
    }
    const result = await deps.music.play(
      interaction.guildId,
      userVoice(interaction),
      tagTracks(playlist.tracks, interaction.user),
      'end',
    )
    if (!result.ok) {
      await present(interaction, { content: result.message })
      return
    }
    await replyWithPlayer(interaction, interaction.guildId, result.message)
  }

  async function runCommand(interaction) {
    const { commandName } = interaction
    const guildId = interaction.guildId
    const settings = settingsFor(guildId)
    if (PLACEMENTS[commandName]) {
      await playResolved(interaction, PLACEMENTS[commandName])
      return
    }
    if (commandName === 'search') {
      const results = await resolveTracks({
        query: interaction.options.getString('query', true),
        mode: 'search',
        limit: 10,
      })
      rememberSearch(guildId, interaction.user.id, results)
      await present(interaction, { content: 'Pick a track.', ...searchMenu(results) })
      return
    }
    if (commandName === 'playlist') {
      await onPlaylist(interaction)
      return
    }
    if (commandName === 'pause') {
      const result = await deps.music.pause(guildId)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'resume') {
      const result = await deps.music.resume(guildId)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'skip') {
      const result = await deps.music.skip(guildId)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'back') {
      const result = await deps.music.back(guildId)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'replay') {
      const result = await deps.music.replay(guildId)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'stop') {
      const result = await deps.music.stop(guildId)
      await present(interaction, { content: result.message })
      return
    }
    if (commandName === 'leave') {
      const result = await deps.music.leave(guildId)
      await present(interaction, { content: result.message })
      return
    }
    if (commandName === 'join') {
      const result = await deps.music.join(guildId, userVoice(interaction))
      await present(interaction, { content: result.message })
      return
    }
    if (commandName === 'queue') {
      await present(interaction, { content: formatQueue(deps.music.snapshot(guildId)) })
      return
    }
    if (commandName === 'nowplaying') {
      await replyWithPlayer(interaction, guildId, 'Player updated.')
      return
    }
    if (commandName === 'loop') {
      const mode = interaction.options.getString('mode', true)
      if (!LOOP_MODES.includes(mode)) {
        await finish(interaction, 'Unknown loop mode.')
        return
      }
      const result = await deps.music.loop(guildId, mode)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'shuffle') {
      const result = await deps.music.shuffle(guildId)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'move') {
      const result = await deps.music.move(
        guildId,
        interaction.options.getInteger('from', true),
        interaction.options.getInteger('to', true),
      )
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'remove') {
      const result = await deps.music.remove(guildId, interaction.options.getInteger('index', true))
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'clear') {
      const result = await deps.music.clear(guildId)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'seek') {
      const position = parseClock(interaction.options.getString('position', true))
      if (position == null) {
        await present(interaction, { content: 'Use seconds or a timestamp like 1:30.' })
        return
      }
      const result = await deps.music.seek(guildId, position)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'forward' || commandName === 'rewind') {
      const seconds = interaction.options.getInteger('seconds') ?? 10
      const delta = (commandName === 'forward' ? 1 : -1) * seconds * 1000
      const result = await deps.music.nudge(guildId, delta)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'volume') {
      const result = await deps.music.volume(guildId, interaction.options.getInteger('level', true))
      await present(interaction, { content: result.message })
      return
    }
    if (commandName === 'filter') {
      const preset = interaction.options.getString('preset', true)
      if (!FILTER_IDS.includes(preset)) {
        await finish(interaction, 'Unknown filter.')
        return
      }
      writeGuild(guildId, { filter: preset })
      const result = await deps.music.setFilter(guildId, preset)
      await afterControl(interaction, guildId, result)
      return
    }
    if (commandName === 'sleep') {
      const result = await deps.music.sleep(guildId, interaction.options.getInteger('minutes', true))
      await present(interaction, { content: result.message })
      return
    }
    if (commandName === 'ping') {
      const gateway = interaction.client?.ws?.ping
      const took = now() - interaction.createdTimestamp
      const heartbeat = Number.isFinite(gateway) ? `${Math.round(gateway)} ms` : 'n/a'
      await present(interaction, { content: `Pong. Gateway ${heartbeat}. Round trip ${Math.max(0, took)} ms.` })
      return
    }
    if (commandName === 'settings') {
      await onSettings(interaction, settings)
      return
    }
    if (commandName === 'setup') {
      await onSetup(interaction)
      return
    }
    if (commandName === 'setdj') {
      const clear = interaction.options.getBoolean('clear')
      const role = interaction.options.getRole('role')
      if (clear) writeGuild(guildId, { djRoleId: null })
      else if (role) writeGuild(guildId, { djRoleId: role.id })
      else {
        await finish(interaction, settings.djRoleId ? 'A DJ role is set.' : 'No DJ role is set.')
        return
      }
      await finish(interaction, clear ? 'DJ role removed.' : 'DJ role updated.')
      return
    }
    if (commandName === 'setdjonly') {
      const name = interaction.options.getString('command', true)
      const enabled = interaction.options.getBoolean('enabled', true)
      const next = new Set(settings.djOnly)
      if (enabled) next.add(name)
      else next.delete(name)
      writeGuild(guildId, { djOnly: [...next] })
      await finish(interaction, enabled ? `/${name} now requires the DJ role.` : `/${name} is no longer DJ-only.`)
      return
    }
    if (commandName === 'texttoggle' || commandName === 'voicetoggle') {
      const channel = interaction.options.getChannel('channel', true)
      const key = commandName === 'texttoggle' ? 'textChannels' : 'voiceChannels'
      const current = settings[key]
      const next = current.includes(channel.id)
        ? current.filter((id) => id !== channel.id)
        : [...current, channel.id]
      writeGuild(guildId, { [key]: next })
      await finish(
        interaction,
        next.length === 0
          ? 'That limit is off.'
          : next.includes(channel.id) ? 'That channel is now allowed.' : 'That channel is no longer on the list.',
      )
      return
    }
    await finish(interaction, 'Unknown command.')
  }

  async function afterControl(interaction, guildId, result) {
    if (!result.ok) {
      await present(interaction, { content: result.message })
      return
    }
    await replyWithPlayer(interaction, guildId, result.message)
  }

  async function onSettings(interaction, settings) {
    const sub = interaction.options.getSubcommand()
    const guildId = interaction.guildId
    if (sub === 'show') {
      const lines = [
        `Volume: ${settings.defaultVolume}%`,
        `Queue: ${waitingLimit(settings)} waiting tracks${settings.extendedQueue ? ' (extended)' : ''}`,
        `Autoplay: ${settings.autoplay ? 'on' : 'off'}`,
        `24/7: ${settings.stayConnected ? 'on' : 'off'}`,
        `Filter: ${settings.filter === '8d' ? '8D' : settings.filter}`,
        `DJ role: ${settings.djRoleId ? 'set' : 'unset'}`,
        `DJ-only: ${settings.djOnly.length === 0 ? 'none' : settings.djOnly.join(', ')}`,
      ]
      await finish(interaction, lines.join('\n'))
      return
    }
    if (sub === 'volume') {
      const level = interaction.options.getInteger('level', true)
      writeGuild(guildId, { defaultVolume: level })
      await finish(interaction, `Default volume is ${level}%.`)
      return
    }
    if (sub === 'autoplay') {
      const enabled = interaction.options.getBoolean('enabled', true)
      writeGuild(guildId, { autoplay: enabled })
      await finish(interaction, `Autoplay is ${enabled ? 'on' : 'off'}.`)
      return
    }
    if (sub === 'extended') {
      const enabled = interaction.options.getBoolean('enabled', true)
      const size = interaction.options.getInteger('size')
      const patch = { extendedQueue: enabled }
      if (size != null) patch.maxQueueSize = size
      writeGuild(guildId, patch)
      await finish(interaction, enabled ? 'Extended queue is on.' : 'Extended queue is off. The cap is 100.')
      return
    }
    const enabled = interaction.options.getBoolean('enabled', true)
    writeGuild(guildId, { stayConnected: enabled })
    await deps.music.noteStay(guildId, enabled)
    await finish(interaction, enabled ? '24/7 mode is on.' : '24/7 mode is off.')
  }

  async function onSetup(interaction) {
    if (!deps.requestChannel) {
      await finish(
        interaction,
        'Song requests are off. Set ENABLE_REQUEST_CHANNEL=true and restart to enable them. The base bot does not use the Message Content intent.',
      )
      return
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const channel = interaction.options.getChannel('channel', true)
    const me = interaction.guild.members.me
    const permissions = channel.permissionsFor?.(me)
    if (
      permissions
      && (!permissions.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages))
    ) {
      await present(interaction, { content: 'I need View Channel and Send Messages there.' })
      return
    }
    const patch = { requestChannelId: channel.id }
    const autodelete = interaction.options.getBoolean('autodelete')
    const commandsonly = interaction.options.getBoolean('commandsonly')
    if (autodelete != null) patch.requestAutoDelete = autodelete
    if (commandsonly != null) patch.requestCommandsOnly = commandsonly
    writeGuild(interaction.guildId, patch)
    if (deps.panels) {
      await deps.panels.show(
        interaction.guildId,
        channel,
        nowPlayingPayload(deps.music.snapshot(interaction.guildId), now()),
      )
      deps.progress?.mark(interaction.guildId)
    }
    const deleteNote = patch.requestAutoDelete
      ? ' Auto-delete needs the Manage Messages permission.'
      : ''
    await present(interaction, { content: `Request channel set.${deleteNote}` })
  }

  async function onButton(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply(ephemeral('This bot only works in servers.'))
      return
    }
    const snapshot = deps.music.snapshot(interaction.guildId)
    const commandName = commandForButton(interaction.customId, snapshot)
    if (!commandName) {
      await interaction.reply(ephemeral('Unknown control.'))
      return
    }
    const settings = settingsFor(interaction.guildId)
    const denial = authorize({
      commandName,
      settings,
      member: interaction.member,
      channelId: interaction.channelId,
      requestChannelActive: Boolean(deps.requestChannel),
    })
    const voiceDenial = denial ?? checkVoice(commandName, interaction, settings)
    if (voiceDenial) {
      await interaction.reply(ephemeral(voiceDenial))
      return
    }
    await interaction.deferUpdate()
    const result = await runButton(commandName, interaction.guildId)
    await interaction.editReply(nowPlayingPayload(deps.music.snapshot(interaction.guildId), now()))
    deps.progress?.mark(interaction.guildId)
    if (!result.ok) await interaction.followUp(ephemeral(result.message))
  }

  async function runButton(commandName, guildId) {
    if (commandName === 'pause') return deps.music.pause(guildId)
    if (commandName === 'resume') return deps.music.resume(guildId)
    if (commandName === 'skip') return deps.music.skip(guildId)
    if (commandName === 'back') return deps.music.back(guildId)
    if (commandName === 'loop') {
      const snapshot = deps.music.snapshot(guildId)
      const order = ['off', 'song', 'queue']
      const next = order[(order.indexOf(snapshot.loop) + 1) % order.length]
      return deps.music.loop(guildId, next)
    }
    if (commandName === 'shuffle') return deps.music.shuffle(guildId)
    return deps.music.stop(guildId)
  }

  async function onSelect(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply(ephemeral('This bot only works in servers.'))
      return
    }
    if (interaction.customId !== 'search:pick') {
      await interaction.reply(ephemeral('Unknown menu.'))
      return
    }
    const saved = searches.get(`${interaction.guildId}:${interaction.user.id}`)
    const index = Number(interaction.values?.[0])
    const track = saved && now() - saved.at <= SEARCH_TTL_MS ? saved.results[index] : null
    if (!track) {
      await interaction.reply(ephemeral('That search expired. Run /search again.'))
      return
    }
    const settings = settingsFor(interaction.guildId)
    const denial = authorize({
      commandName: 'play',
      settings,
      member: interaction.member,
      channelId: interaction.channelId,
      requestChannelActive: Boolean(deps.requestChannel),
    })
    const voiceDenial = denial ?? checkVoice('play', interaction, settings)
    if (voiceDenial) {
      await interaction.reply(ephemeral(voiceDenial))
      return
    }
    await interaction.deferUpdate()
    const result = await deps.music.play(
      interaction.guildId,
      userVoice(interaction),
      tagTracks([track], interaction.user),
      'end',
    )
    await interaction.editReply({
      content: result.ok ? `Playing **${safeLabel(track.title)}**.` : result.message,
      components: [],
      allowedMentions: SAFE_MENTIONS,
    })
    if (result.ok) {
      await showSavedPanel(interaction.guild, interaction.guildId)
      deps.progress?.push?.(interaction.guildId, 'action')
    }
  }

  async function handleInteraction(interaction) {
    try {
      if (interaction.isButton?.()) {
        await onButton(interaction)
        return
      }
      if (interaction.isStringSelectMenu?.()) {
        await onSelect(interaction)
        return
      }
      if (!interaction.isChatInputCommand?.()) return
      if (!interaction.inGuild()) {
        await finish(interaction, 'This bot only works in servers.')
        return
      }
      const settings = settingsFor(interaction.guildId)
      let voiceCommand = interaction.commandName
      if (interaction.commandName === 'playlist' && interaction.options.getSubcommand(false) === 'play') {
        voiceCommand = 'play'
      }
      const denial = authorize({
        commandName: interaction.commandName,
        settings,
        member: interaction.member,
        channelId: interaction.channelId,
        requestChannelActive: Boolean(deps.requestChannel),
      })
      const playDenial = voiceCommand === 'play' && interaction.commandName !== 'play'
        ? authorize({
          commandName: 'play',
          settings,
          member: interaction.member,
          channelId: interaction.channelId,
          requestChannelActive: Boolean(deps.requestChannel),
        })
        : null
      if (denial || playDenial) {
        await finish(interaction, denial || playDenial)
        return
      }
      const voiceDenial = checkVoice(voiceCommand, interaction, settings)
      if (voiceDenial) {
        await finish(interaction, voiceDenial)
        return
      }
      if (LOCKED.has(interaction.commandName) && !interaction.deferred && !interaction.replied) {
        const sub = interaction.commandName === 'playlist' ? interaction.options.getSubcommand(false) : null
        const hidden = interaction.commandName === 'search'
          || (interaction.commandName === 'playlist' && sub !== 'play')
        await interaction.deferReply(hidden ? { flags: MessageFlags.Ephemeral } : undefined)
      }
      await runCommand(interaction)
    } catch (error) {
      logError(error)
      await finish(interaction, error instanceof SourceError ? error.message : publicError(error)).catch(logError)
    }
  }

  async function handleMessage(message) {
    if (!deps.requestChannel) return
    if (!message.guildId || message.author?.bot) return
    const settings = settingsFor(message.guildId)
    if (!settings.requestChannelId || message.channelId !== settings.requestChannelId) return
    const content = String(message.content ?? '').trim()
    if (!content || content.startsWith('/')) return
    const denial = authorize({
      commandName: 'play',
      settings,
      member: message.member,
      channelId: message.channelId,
      requestChannelActive: true,
    })
    if (denial) {
      await message.channel.send(plainMessage(denial)).catch(logError)
      return
    }
    const voice = message.member?.voice?.channel
    if (!voice || voice.type === ChannelType.GuildStageVoice) {
      await message.channel.send(plainMessage('Join a voice channel first.')).catch(logError)
      return
    }
    if (!voiceAllowed(settings, voice.id)) {
      await message.channel.send(plainMessage('That voice channel is not allowed.')).catch(logError)
      return
    }
    const botChannel = message.guild.members?.me?.voice?.channelId
    if (botChannel && botChannel !== voice.id) {
      await message.channel.send(plainMessage('I am already playing in another voice channel.')).catch(logError)
      return
    }
    const voicePermissions = voice.permissionsFor?.(message.guild.members?.me)
    if (
      voicePermissions
      && (!voicePermissions.has(PermissionFlagsBits.Connect) || !voicePermissions.has(PermissionFlagsBits.Speak))
    ) {
      await message.channel.send(plainMessage('I need Connect and Speak in that voice channel.')).catch(logError)
      return
    }
    try {
      const tracks = await resolveTracks({
        query: content,
        mode: 'one',
        limit: waitingLimit(settings),
      })
      const result = await deps.music.play(message.guildId, voice, tagTracks(tracks, message.author), 'end')
      if (!result.ok) {
        await message.channel.send(plainMessage(result.message)).catch(logError)
        return
      }
      if (settings.requestAutoDelete) {
        const me = message.guild.members.me
        if (message.channel.permissionsFor?.(me)?.has(PermissionFlagsBits.ManageMessages)) {
          await message.delete().catch(logError)
        }
      }
      if (deps.panels) {
        await deps.panels.show(
          message.guildId,
          message.channel,
          nowPlayingPayload(deps.music.snapshot(message.guildId), now()),
        )
        deps.progress?.mark(message.guildId)
      }
    } catch (error) {
      logError(error)
      await message.channel.send(plainMessage("I couldn't play that.")).catch(logError)
    }
  }

  return { handleInteraction, handleMessage, searches }
}

function plainMessage(content) {
  return { content, allowedMentions: SAFE_MENTIONS }
}
