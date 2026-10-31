import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

const userOption = (required = true) => (option) => option
  .setName('user')
  .setDescription('Member')
  .setRequired(required)

const reasonOption = (required = true) => (option) => option
  .setName('reason')
  .setDescription('Reason recorded in the mod log')
  .setRequired(required)
  .setMaxLength(400)

export const commands = [
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Record a warning for a member.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOption())
    .addStringOption(reasonOption()),
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Time a member out.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOption())
    .addIntegerOption((option) => option
      .setName('minutes')
      .setDescription('Timeout length in minutes (28 days max)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(40320))
    .addStringOption(reasonOption()),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(userOption())
    .addStringOption(reasonOption()),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(userOption())
    .addStringOption(reasonOption())
    .addIntegerOption((option) => option
      .setName('delete_days')
      .setDescription('Delete their recent messages, in days')
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(7)),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete recent messages from this channel.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) => option
      .setName('count')
      .setDescription('How many messages to delete (14 days max)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100))
    .addUserOption((option) => option
      .setName('user')
      .setDescription('Only delete messages from this user')
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName('raid')
    .setDescription('Turn raid mode on or off for this server.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((option) => option
      .setName('state')
      .setDescription('Whether raid mode is active')
      .setRequired(true)
      .addChoices(
        { name: 'On', value: 'on' },
        { name: 'Off', value: 'off' },
      )),
]

export function commandData() {
  return commands.map((command) => command.toJSON())
}
