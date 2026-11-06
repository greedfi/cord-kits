import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

export const commands = [
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open or close a private ticket channel.')
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('panel')
      .setDescription('Post a button that opens a ticket.')
      .addChannelOption((option) => option.setName('channel').setDescription('Channel for the button').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('open')
      .setDescription('Open a private ticket channel.')
      .addStringOption((option) => option.setName('reason').setDescription('Why you are opening it').setRequired(false).setMaxLength(200)))
    .addSubcommand((sub) => sub
      .setName('close')
      .setDescription('Ask to close this ticket.'))
    .addSubcommand((sub) => sub
      .setName('transcript')
      .setDescription('Read a saved transcript. Staff role only.')
      .addStringOption((option) => option.setName('id').setDescription('Ticket id').setRequired(true).setMinLength(12).setMaxLength(12))),
]

export function commandData() {
  const body = commands.map((command) => command.toJSON())
  const byName = Object.fromEntries(body[0].options.map((option) => [option.name, option]))
  // discord.js subcommand builders do not expose this field. The REST payload does.
  byName.panel.default_member_permissions = String(PermissionFlagsBits.ManageChannels)
  byName.transcript.default_member_permissions = String(PermissionFlagsBits.ManageChannels)
  return body
}
