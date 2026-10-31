import { REST, Routes } from 'discord.js'
import { commandData } from './commands.js'
import { isDirectRun, loadEnv, redact, requireEnv } from './env.js'

export async function registerCommands() {
  loadEnv()
  const token = requireEnv('DISCORD_BOT_TOKEN')
  const clientId = requireEnv('CLIENT_ID')
  if (!/^\d{17,20}$/.test(clientId)) {
    throw new Error('CLIENT_ID should be the numeric application id.')
  }
  const guildId = process.env.GUILD_ID?.trim()
  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    throw new Error('GUILD_ID should be a numeric server id.')
  }
  const rest = new REST({ version: '10' }).setToken(token)
  const body = commandData()
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body })
    console.log(`Registered ${body.length} commands for guild ${guildId}.`)
    return
  }
  await rest.put(Routes.applicationCommands(clientId), { body })
  console.log(`Registered ${body.length} global commands.`)
}

if (isDirectRun(import.meta.url)) {
  registerCommands().catch((error) => {
    console.error(redact(error.message))
    process.exit(1)
  })
}
