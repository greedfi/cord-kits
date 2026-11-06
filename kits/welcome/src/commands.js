import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'

export const commands = [
  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Post the rules-acceptance button.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Channel for the button')
      .setRequired(true)),
]

export function commandData() {
  return commands.map((command) => command.toJSON())
}
