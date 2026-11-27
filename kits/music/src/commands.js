import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'
import { CONFIG_COMMANDS, CONTROL_COMMANDS, LOOP_MODES, OPEN_COMMANDS } from './catalog.js'

const connect = PermissionFlagsBits.Connect
const manage = PermissionFlagsBits.ManageGuild

function command(name, description, permission) {
  const builder = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false)
  if (permission) builder.setDefaultMemberPermissions(permission)
  return builder
}

function queryOption(option, description) {
  return option.setName('query').setDescription(description).setRequired(false).setMaxLength(200)
}

function playOptions(builder) {
  return builder
    .addStringOption((option) => queryOption(option, 'Song name, SoundCloud link, direct audio URL, or radio stream'))
    .addAttachmentOption((option) => option.setName('file').setDescription('Audio file to play').setRequired(false))
    .addStringOption((option) => option
      .setName('kind')
      .setDescription('How to read a URL. A name is always a SoundCloud search.')
      .setRequired(false)
      .addChoices(
        { name: 'Auto', value: 'auto' },
        { name: 'SoundCloud', value: 'soundcloud' },
        { name: 'Direct audio', value: 'direct' },
        { name: 'Radio stream', value: 'radio' },
      ))
}

const playlist = command('playlist', 'Save and play lists of tracks on this server.', connect)
  .addSubcommand((sub) => sub
    .setName('create')
    .setDescription('Create an empty playlist.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
  .addSubcommand((sub) => sub
    .setName('add')
    .setDescription('Add a song, search, or SoundCloud playlist.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32))
    .addStringOption((option) => queryOption(option, 'Song name or URL').setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('addtrack')
    .setDescription('Add one track to a playlist.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32))
    .addStringOption((option) => queryOption(option, 'Song name or URL').setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('addqueue')
    .setDescription('Add the current queue to a playlist.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
  .addSubcommand((sub) => sub
    .setName('show')
    .setDescription('Show a playlist.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
  .addSubcommand((sub) => sub
    .setName('play')
    .setDescription('Play a saved playlist.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
  .addSubcommand((sub) => sub
    .setName('remove')
    .setDescription('Remove one track from a playlist.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32))
    .addIntegerOption((option) => option.setName('index').setDescription('Track number').setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub
    .setName('delete')
    .setDescription('Delete a playlist.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
  .addSubcommand((sub) => sub
    .setName('share')
    .setDescription('Create a code another server can import.')
    .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
  .addSubcommand((sub) => sub
    .setName('import')
    .setDescription('Import a shared playlist as a read-only copy.')
    .addStringOption((option) => option.setName('code').setDescription('Share code').setRequired(true).setMaxLength(32)))

const settings = command('settings', 'Show or change this server\'s playback defaults.', manage)
  .addSubcommand((sub) => sub.setName('show').setDescription('Show this server\'s playback defaults.'))
  .addSubcommand((sub) => sub
    .setName('volume')
    .setDescription('Set the default volume.')
    .addIntegerOption((option) => option.setName('level').setDescription('Volume percent').setRequired(true).setMinValue(0).setMaxValue(100)))
  .addSubcommand((sub) => sub
    .setName('autoplay')
    .setDescription('Play a related SoundCloud track when the queue ends.')
    .addBooleanOption((option) => option.setName('enabled').setDescription('Turn autoplay on or off').setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('extended')
    .setDescription('Raise the queue cap from 100 to the configured size, up to 1000.')
    .addBooleanOption((option) => option.setName('enabled').setDescription('Turn the extended queue on or off').setRequired(true))
    .addIntegerOption((option) => option.setName('size').setDescription('Waiting tracks, from 1 to 1000').setRequired(false).setMinValue(1).setMaxValue(1000)))
  .addSubcommand((sub) => sub
    .setName('stay')
    .setDescription('Stay in voice and rejoin after a restart or disconnect.')
    .addBooleanOption((option) => option.setName('enabled').setDescription('Turn 24/7 mode on or off').setRequired(true)))

export const commands = [
  playOptions(command('play', 'Play a song by name or URL, or an audio attachment.', connect)),
  playOptions(command('playskip', 'Replace the current song and play this now.', connect)),
  playOptions(command('playtop', 'Add a song to the front of the queue.', connect)),
  command('search', 'Search SoundCloud and pick a result.', connect)
    .addStringOption((option) => option.setName('query').setDescription('Song name').setRequired(true).setMaxLength(200)),
  command('pause', 'Pause playback.', connect),
  command('resume', 'Resume playback.', connect),
  command('skip', 'Skip the current track.', connect),
  command('back', 'Play the previous track.', connect),
  command('replay', 'Start the current track again.', connect),
  command('stop', 'Stop playback and clear the queue.', connect),
  command('queue', 'Show the current track and the waiting queue.'),
  command('nowplaying', 'Show the player controls.'),
  command('loop', 'Repeat the song, the queue, or turn repeat off.', connect)
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('Repeat mode')
      .setRequired(true)
      .addChoices(...LOOP_MODES.map((mode) => ({ name: mode, value: mode })))),
  command('shuffle', 'Shuffle the waiting queue.', connect),
  command('move', 'Move a waiting track to another position.', connect)
    .addIntegerOption((option) => option.setName('from').setDescription('Current position').setRequired(true).setMinValue(1))
    .addIntegerOption((option) => option.setName('to').setDescription('New position').setRequired(true).setMinValue(1)),
  command('remove', 'Remove a waiting track.', connect)
    .addIntegerOption((option) => option.setName('index').setDescription('Position in the waiting queue').setRequired(true).setMinValue(1)),
  command('clear', 'Remove every waiting track.', connect),
  command('seek', 'Seek to a timestamp in the current track.', connect)
    .addStringOption((option) => option.setName('position').setDescription('Timestamp, such as 90 or 1:30').setRequired(true).setMaxLength(8)),
  command('forward', 'Skip ahead in the current track.', connect)
    .addIntegerOption((option) => option.setName('seconds').setDescription('Seconds to skip').setRequired(false).setMinValue(1).setMaxValue(300)),
  command('rewind', 'Skip back in the current track.', connect)
    .addIntegerOption((option) => option.setName('seconds').setDescription('Seconds to skip').setRequired(false).setMinValue(1).setMaxValue(300)),
  command('volume', 'Set playback volume from 0 to 100.', connect)
    .addIntegerOption((option) => option.setName('level').setDescription('Volume percent').setRequired(true).setMinValue(0).setMaxValue(100)),
  command('join', 'Join your voice channel.', connect),
  command('leave', 'Leave the voice channel and stop playback.', connect),
  command('ping', 'Show the bot latency.'),
  command('sleep', 'Leave the voice channel after a number of minutes.', connect)
    .addIntegerOption((option) => option.setName('minutes').setDescription('Minutes to wait. Use 0 to cancel.').setRequired(true).setMinValue(0).setMaxValue(360)),
  command('filter', 'Apply a bass boost, nightcore, or 8D filter.', connect)
    .addStringOption((option) => option
      .setName('preset')
      .setDescription('Filter preset')
      .setRequired(true)
      .addChoices(
        { name: 'Off', value: 'off' },
        { name: 'Bass boost', value: 'bassboost' },
        { name: 'Nightcore', value: 'nightcore' },
        { name: '8D', value: '8d' },
      )),
  settings,
  command('setup', 'Set the song request channel.', manage)
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Channel where members type song names')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText))
    .addBooleanOption((option) => option.setName('autodelete').setDescription('Delete request messages').setRequired(false))
    .addBooleanOption((option) => option.setName('commandsonly').setDescription('Allow music commands only in that channel').setRequired(false)),
  command('setdj', 'Set the DJ role.', manage)
    .addRoleOption((option) => option.setName('role').setDescription('Role that can use DJ commands').setRequired(false))
    .addBooleanOption((option) => option.setName('clear').setDescription('Remove the DJ role').setRequired(false)),
  command('setdjonly', 'Choose which commands require the DJ role.', manage)
    .addStringOption((option) => option
      .setName('command')
      .setDescription('Command name')
      .setRequired(true)
      .addChoices(...CONTROL_COMMANDS.map((name) => ({ name, value: name }))))
    .addBooleanOption((option) => option.setName('enabled').setDescription('Require the DJ role').setRequired(true)),
  command('texttoggle', 'Allow or block a text channel.', manage)
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Text channel')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText)),
  command('voicetoggle', 'Allow or block a voice channel.', manage)
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Voice channel')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildVoice)),
  playlist,
]

export function commandData() {
  return commands.map((entry) => entry.toJSON())
}

export const commandNames = [...CONTROL_COMMANDS, ...CONFIG_COMMANDS, ...OPEN_COMMANDS]
