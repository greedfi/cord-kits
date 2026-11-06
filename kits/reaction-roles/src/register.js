import { REST, Routes } from 'discord.js'
import { commandData } from './commands.js'
import { isDirectRun, loadEnv, redact, requireEnv } from './env.js'

export function validateCommandPayload(commands) {
  if (!Array.isArray(commands) || commands.length === 0) throw new Error('No commands to register.')
  const names = new Set()
  for (const command of commands) {
    if (!/^[\w-]{1,32}$/.test(command.name ?? '')) throw new Error(`Bad command name ${command.name}`)
    if (names.has(command.name)) throw new Error(`Duplicate command ${command.name}`)
    names.add(command.name)
    if (!command.description || command.description.length > 100) {
      throw new Error(`Bad description for ${command.name}`)
    }
    if (command.dm_permission !== false) throw new Error(`${command.name} must disable DMs`)
  }
  return commands
}

export function registrationTarget(clientId, guildId) {
  if (!/^\d{17,20}$/.test(clientId)) throw new Error('CLIENT_ID should be the numeric application id.')
  if (guildId) {
    if (!/^\d{17,20}$/.test(guildId)) throw new Error('GUILD_ID should be a numeric server id.')
    return { scope: 'guild', path: Routes.applicationGuildCommands(clientId, guildId) }
  }
  return { scope: 'global', path: Routes.applicationCommands(clientId) }
}

export async function registerCommands({ rest } = {}) {
  loadEnv()
  const token = requireEnv('DISCORD_BOT_TOKEN')
  const clientId = requireEnv('CLIENT_ID')
  const guildId = process.env.GUILD_ID?.trim()
  const target = registrationTarget(clientId, guildId)
  const body = validateCommandPayload(commandData())
  const client = rest ?? new REST({ version: '10' }).setToken(token)
  await client.put(target.path, { body })
  console.log(`Registered ${body.length} ${target.scope} command(s).`)
  return target
}

if (isDirectRun(import.meta.url)) {
  registerCommands().catch((error) => {
    console.error(redact(error.message))
    process.exit(1)
  })
}
