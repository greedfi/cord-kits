import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

export const commands = [
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create, end, cancel, or reroll a giveaway.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub
      .setName('create')
      .setDescription('Start a giveaway in a channel.')
      .addStringOption((option) => option
        .setName('prize')
        .setDescription('What the winner receives')
        .setRequired(true)
        .setMaxLength(180))
      .addIntegerOption((option) => option
        .setName('minutes')
        .setDescription('How long the giveaway stays open')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(43200))
      .addIntegerOption((option) => option
        .setName('winners')
        .setDescription('How many winners to draw')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(20))
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('Channel that will hold the giveaway')
        .setRequired(true))
      .addRoleOption((option) => option
        .setName('required_role')
        .setDescription('Optional role an entrant must already have')
        .setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('end')
      .setDescription('Draw winners now.')
      .addStringOption((option) => option
        .setName('id')
        .setDescription('Giveaway id')
        .setRequired(true)
        .setMinLength(12)
        .setMaxLength(12)))
    .addSubcommand((sub) => sub
      .setName('cancel')
      .setDescription('Cancel a giveaway without drawing winners.')
      .addStringOption((option) => option
        .setName('id')
        .setDescription('Giveaway id')
        .setRequired(true)
        .setMinLength(12)
        .setMaxLength(12)))
    .addSubcommand((sub) => sub
      .setName('reroll')
      .setDescription('Draw replacement winners from people who did not win.')
      .addStringOption((option) => option
        .setName('id')
        .setDescription('Giveaway id')
        .setRequired(true)
        .setMinLength(12)
        .setMaxLength(12))),
]

export function commandData() {
  return commands.map((command) => command.toJSON())
}
