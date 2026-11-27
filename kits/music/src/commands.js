import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'
import { FILTER_NAMES } from './limits.js'

const connect = PermissionFlagsBits.Connect
const manage = PermissionFlagsBits.ManageGuild

function playOptions(builder, description) {
  return builder
    .setDescription(description)
    .setDMPermission(false)
    .setDefaultMemberPermissions(connect)
    .addStringOption((option) => option
      .setName('query')
      .setDescription('Track name, SoundCloud link, direct audio URL, or radio stream')
      .setRequired(false))
    .addAttachmentOption((option) => option
      .setName('file')
      .setDescription('Audio file to play')
      .setRequired(false))
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

function control(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false)
    .setDefaultMemberPermissions(connect)
}

function manager(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false)
    .setDefaultMemberPermissions(manage)
}

export const commands = [
  playOptions(
    new SlashCommandBuilder().setName('play'),
    'Play SoundCloud, a direct audio URL, a radio stream, or an attachment.',
  ),
  playOptions(
    new SlashCommandBuilder().setName('playskip'),
    'Skip what is playing and start this track now.',
  ),
  playOptions(
    new SlashCommandBuilder().setName('playtop'),
    'Queue this track next, ahead of the waiting list.',
  ),
  control('pause', 'Pause the current track.'),
  control('resume', 'Resume the current track.'),
  control('skip', 'Skip the current track.'),
  control('back', 'Play the previous track.'),
  control('replay', 'Restart the current track.'),
  control('stop', 'Stop playback and clear the queue.'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current track and the waiting queue.')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the player, with controls and progress.')
    .setDMPermission(false),
  control('loop', 'Set loop to one song, the whole queue, or off.')
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('Loop mode')
      .setRequired(true)
      .addChoices(
        { name: 'Song', value: 'song' },
        { name: 'Queue', value: 'queue' },
        { name: 'Off', value: 'off' },
      )),
  control('shuffle', 'Turn shuffle on or off. Turning it on mixes the waiting list.'),
  control('move', 'Move a waiting track to another position.')
    .addIntegerOption((option) => option.setName('from').setDescription('Current position, starting at 1').setRequired(true).setMinValue(1).setMaxValue(1000))
    .addIntegerOption((option) => option.setName('to').setDescription('New position, starting at 1').setRequired(true).setMinValue(1).setMaxValue(1000)),
  control('remove', 'Remove a waiting track by its position.')
    .addIntegerOption((option) => option.setName('index').setDescription('Position, starting at 1').setRequired(true).setMinValue(1).setMaxValue(1000)),
  control('clear', 'Remove every waiting track. The current track keeps playing.'),
  control('seek', 'Jump to a position in the current track.')
    .addIntegerOption((option) => option.setName('seconds').setDescription('Position in seconds').setRequired(true).setMinValue(0).setMaxValue(86400)),
  control('forward', 'Skip ahead in the current track.')
    .addIntegerOption((option) => option.setName('seconds').setDescription('Seconds to skip ahead').setRequired(false).setMinValue(1).setMaxValue(3600)),
  control('rewind', 'Skip back in the current track.')
    .addIntegerOption((option) => option.setName('seconds').setDescription('Seconds to skip back').setRequired(false).setMinValue(1).setMaxValue(3600)),
  control('volume', 'Set playback volume from 0 to 100.')
    .addIntegerOption((option) => option.setName('level').setDescription('Volume percent').setRequired(true).setMinValue(0).setMaxValue(100)),
  control('join', 'Join your voice channel without playing.'),
  control('leave', 'Leave voice and turn off 24/7 mode.'),
  control('search', 'Search SoundCloud and pick a result.')
    .addStringOption((option) => option.setName('query').setDescription('Track or artist name').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Show the gateway latency.')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Show or update playback defaults for this server.')
    .setDMPermission(false)
    .addIntegerOption((option) => option.setName('volume').setDescription('Saved default volume').setRequired(false).setMinValue(0).setMaxValue(100))
    .addIntegerOption((option) => option.setName('queue').setDescription('Saved waiting-track limit, max 1000').setRequired(false).setMinValue(1).setMaxValue(1000))
    .addBooleanOption((option) => option.setName('autoplay').setDescription('Queue a related SoundCloud track when the queue ends').setRequired(false))
    .addStringOption((option) => option
      .setName('filter')
      .setDescription('Saved filter for new playback')
      .setRequired(false)
      .addChoices(...FILTER_NAMES.map((name) => ({ name, value: name })))),
  manager('setup', 'Set the song-request channel. Requires the opt-in message intent.')
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Channel where a message queues a track')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false))
    .addBooleanOption((option) => option.setName('autodelete').setDescription('Delete messages after they are queued').setRequired(false))
    .addBooleanOption((option) => option.setName('commandsonly').setDescription('Allow music commands only in this channel').setRequired(false))
    .addBooleanOption((option) => option.setName('disable').setDescription('Clear the song-request channel').setRequired(false)),
  manager('setdj', 'Set or clear the DJ role.')
    .addRoleOption((option) => option.setName('role').setDescription('DJ role. Omit to clear it.').setRequired(false)),
  manager('setdjonly', 'Choose which commands require the DJ role.')
    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Require the DJ role for a command.')
      .addStringOption((option) => option.setName('command').setDescription('Command name, such as skip').setRequired(true).setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Stop requiring the DJ role for a command.')
      .addStringOption((option) => option.setName('command').setDescription('Command name').setRequired(true).setMaxLength(32)))
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the DJ-only commands.')),
  manager('texttoggle', 'Limit commands to allowed text channels.')
    .addStringOption((option) => option
      .setName('action')
      .setDescription('enable, disable, allow, or deny')
      .setRequired(true)
      .addChoices(
        { name: 'Enable', value: 'enable' },
        { name: 'Disable', value: 'disable' },
        { name: 'Allow channel', value: 'allow' },
        { name: 'Deny channel', value: 'deny' },
      ))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Text channel to allow or deny')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)),
  manager('voicetoggle', 'Limit playback to allowed voice channels.')
    .addStringOption((option) => option
      .setName('action')
      .setDescription('enable, disable, allow, or deny')
      .setRequired(true)
      .addChoices(
        { name: 'Enable', value: 'enable' },
        { name: 'Disable', value: 'disable' },
        { name: 'Allow channel', value: 'allow' },
        { name: 'Deny channel', value: 'deny' },
      ))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Voice channel to allow or deny')
      .addChannelTypes(ChannelType.GuildVoice)
      .setRequired(false)),
  control('sleep', 'Leave voice after a number of minutes, and do not auto-rejoin.')
    .addIntegerOption((option) => option.setName('minutes').setDescription('Minutes from 1 to 180').setRequired(true).setMinValue(1).setMaxValue(180)),
  manager('stay', 'Stay in voice and rejoin after a disconnect or restart.')
    .addBooleanOption((option) => option.setName('enabled').setDescription('Turn 24/7 mode on or off').setRequired(true)),
  control('filter', 'Apply a fixed ffmpeg filter to this server’s playback.')
    .addStringOption((option) => option
      .setName('preset')
      .setDescription('off, bassboost, nightcore, or 8d')
      .setRequired(true)
      .addChoices(...FILTER_NAMES.map((name) => ({ name, value: name })))),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Save playlists on this server, or import a share code.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(connect)
    .addSubcommand((sub) => sub
      .setName('create')
      .setDescription('Create an empty playlist.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Add one track by name or URL.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32))
      .addStringOption((option) => option.setName('query').setDescription('Track name or URL').setRequired(true).setMaxLength(200)))
    .addSubcommand((sub) => sub
      .setName('addtrack')
      .setDescription('Add the current track.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName('addqueue')
      .setDescription('Add the current track and the waiting queue.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName('show')
      .setDescription('Show one playlist, or list them when name is omitted.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(false).setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName('play')
      .setDescription('Queue a saved playlist.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Remove one saved track.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32))
      .addIntegerOption((option) => option.setName('index').setDescription('Track number, starting at 1').setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand((sub) => sub
      .setName('delete')
      .setDescription('Delete a playlist.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName('share')
      .setDescription('Create a code other servers can import, read-only.')
      .addStringOption((option) => option.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(32)))
    .addSubcommand((sub) => sub
      .setName('import')
      .setDescription('Import a share code as a read-only playlist.')
      .addStringOption((option) => option.setName('code').setDescription('Share code').setRequired(true).setMaxLength(32))
      .addStringOption((option) => option.setName('name').setDescription('Name to use on this server').setRequired(true).setMaxLength(32))),
]

export function commandData() {
  return commands.map((command) => command.toJSON())
}
