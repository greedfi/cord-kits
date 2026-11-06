import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

export const commands = [
  new SlashCommandBuilder()
    .setName('roles')
    .setDescription('Create a button or select menu that assigns roles.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) => sub
      .setName('create')
      .setDescription('Create a panel. It is not posted until you publish it.')
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('Channel that will hold the panel')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption((option) => option
        .setName('style')
        .setDescription('Buttons or a select menu')
        .setRequired(true)
        .addChoices(
          { name: 'Buttons', value: 'buttons' },
          { name: 'Select menu', value: 'select' },
        ))
      .addBooleanOption((option) => option
        .setName('exclusive')
        .setDescription('Choosing a role removes the other roles on this panel')
        .setRequired(true))
      .addIntegerOption((option) => option
        .setName('max_roles')
        .setDescription('How many roles from this panel one member may hold')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(25))
      .addStringOption((option) => option
        .setName('title')
        .setDescription('Text shown on the panel')
        .setRequired(true)
        .setMaxLength(180)))
    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Add a role to a panel.')
      .addStringOption((option) => option.setName('panel').setDescription('Panel id').setRequired(true).setMinLength(16).setMaxLength(16))
      .addRoleOption((option) => option.setName('role').setDescription('Role to offer').setRequired(true))
      .addStringOption((option) => option.setName('label').setDescription('Button or menu label').setRequired(true).setMaxLength(80)))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Remove a role from a panel.')
      .addStringOption((option) => option.setName('panel').setDescription('Panel id').setRequired(true).setMinLength(16).setMaxLength(16))
      .addRoleOption((option) => option.setName('role').setDescription('Role to remove').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('publish')
      .setDescription('Post the panel, or update the posted message.')
      .addStringOption((option) => option.setName('panel').setDescription('Panel id').setRequired(true).setMinLength(16).setMaxLength(16)))
    .addSubcommand((sub) => sub
      .setName('delete')
      .setDescription('Delete a panel. The message is left in place.')
      .addStringOption((option) => option.setName('panel').setDescription('Panel id').setRequired(true).setMinLength(16).setMaxLength(16))),
]

export function commandData() {
  return commands.map((command) => command.toJSON())
}
