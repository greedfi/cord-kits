import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

export const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play SoundCloud, a direct audio URL, a radio stream, or an attachment.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Connect)
    .addStringOption((option) => option
      .setName('query')
      .setDescription('SoundCloud link, direct audio URL, or radio stream')
      .setRequired(false))
    .addAttachmentOption((option) => option
      .setName('file')
      .setDescription('Audio file to play')
      .setRequired(false))
    .addStringOption((option) => option
      .setName('kind')
      .setDescription('How to read the URL. Auto detects SoundCloud, files, and streams.')
      .setRequired(false)
      .addChoices(
        { name: 'Auto', value: 'auto' },
        { name: 'SoundCloud', value: 'soundcloud' },
        { name: 'Direct audio', value: 'direct' },
        { name: 'Radio stream', value: 'radio' },
      )),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Connect),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current track and the waiting queue.')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Connect),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume from 0 to 100.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Connect)
    .addIntegerOption((option) => option
      .setName('level')
      .setDescription('Volume percent')
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(100)),
]

export function commandData() {
  return commands.map((command) => command.toJSON())
}
