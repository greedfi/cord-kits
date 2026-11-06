import { SlashCommandBuilder } from 'discord.js'

export const commands = [
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show a member’s level in this server.')
    .setDMPermission(false)
    .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(false)),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top levels in this server.')
    .setDMPermission(false),
]

export function commandData() {
  return commands.map((command) => command.toJSON())
}
