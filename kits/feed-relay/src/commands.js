import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

export const commands = [
  new SlashCommandBuilder()
    .setName('feed')
    .setDescription('Show the status of configured feeds.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub
      .setName('status')
      .setDescription('Show the last result for each feed in this server. URLs are not included.')),
]

export function commandData() {
  return commands.map((command) => command.toJSON())
}
