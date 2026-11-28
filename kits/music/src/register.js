import { REST, Routes, Events } from 'discord.js'
import { commandData } from './commands.js'
import { isDirectRun, loadEnv, redact } from './env.js'

const SNOWFLAKE = /^\d{17,20}$/

export function readGuildId(env = process.env) {
  const guildId = env.GUILD_ID?.trim()
  if (!guildId) return null
  if (!SNOWFLAKE.test(guildId)) throw new Error('GUILD_ID should be a numeric server id.')
  return guildId
}

function projectOption(option) {
  const projected = {
    type: option.type,
    name: option.name,
    description: option.description,
  }
  projected.required = option.required === true
  for (const key of ['min_length', 'max_length', 'min_value', 'max_value', 'autocomplete']) {
    if (option[key] != null) projected[key] = option[key]
  }
  if (Array.isArray(option.channel_types)) projected.channel_types = [...option.channel_types]
  if (Array.isArray(option.choices)) {
    projected.choices = option.choices.map((choice) => ({ name: choice.name, value: choice.value }))
  }
  if (Array.isArray(option.options)) projected.options = option.options.map(projectOption)
  return projected
}

function projectCommand(command) {
  return {
    name: command.name,
    description: command.description ?? '',
    type: command.type ?? 1,
    dm_permission: command.dm_permission === true,
    default_member_permissions: command.default_member_permissions == null
      ? null
      : String(command.default_member_permissions),
    options: (command.options ?? []).map(projectOption),
  }
}

export function sameCommandSet(current, desired) {
  const list = (commands) => commands.map(projectCommand).sort((left, right) => left.name.localeCompare(right.name))
  return JSON.stringify(list(current)) === JSON.stringify(list(desired))
}

async function replaceIfChanged(rest, route, desired) {
  const current = await rest.get(route)
  const list = Array.isArray(current) ? current : []
  if (sameCommandSet(list, desired)) return false
  await rest.put(route, { body: desired })
  return true
}

export async function syncCommands({
  rest,
  clientId,
  guildId = null,
  guildIds = [],
  commands = commandData(),
}) {
  if (!SNOWFLAKE.test(String(clientId ?? ''))) {
    throw new Error('CLIENT_ID should be the numeric application id.')
  }
  if (guildId && !SNOWFLAKE.test(guildId)) throw new Error('GUILD_ID should be a numeric server id.')
  const globalRoute = Routes.applicationCommands(clientId)
  if (guildId) {
    const updated = await replaceIfChanged(rest, Routes.applicationGuildCommands(clientId, guildId), commands)
    const clearedGlobal = await replaceIfChanged(rest, globalRoute, [])
    return { scope: 'guild', guildId, updated, clearedGlobal, clearedGuilds: [] }
  }
  const updated = await replaceIfChanged(rest, globalRoute, commands)
  const clearedGuilds = []
  for (const id of guildIds) {
    if (!SNOWFLAKE.test(id)) continue
    const cleared = await replaceIfChanged(rest, Routes.applicationGuildCommands(clientId, id), [])
    if (cleared) clearedGuilds.push(id)
  }
  return { scope: 'global', guildId: null, updated, clearedGlobal: false, clearedGuilds }
}

export function describeSync(result, count) {
  if (!result) return null
  if (result.scope === 'guild') {
    const line = result.updated
      ? `Registered ${count} commands for guild ${result.guildId}.`
      : `Guild commands already match (${count}).`
    return result.clearedGlobal ? `${line} Cleared global commands.` : line
  }
  const line = result.updated
    ? `Registered ${count} global commands.`
    : `Global commands already match (${count}).`
  if (result.clearedGuilds.length === 0) return line
  return `${line} Cleared guild commands for ${result.clearedGuilds.join(', ')}.`
}

export async function registerCommands({ rest, env = process.env } = {}) {
  if (!rest) loadEnv()
  const source = rest ? env : process.env
  const token = source.DISCORD_BOT_TOKEN?.trim()
  if (!token) throw new Error('Missing DISCORD_BOT_TOKEN. Copy .env.example to .env and set it.')
  const clientId = source.CLIENT_ID?.trim()
  if (!clientId) throw new Error('Missing CLIENT_ID. Copy .env.example to .env and set it.')
  const guildId = readGuildId(source)
  const http = rest ?? new REST({ version: '10' }).setToken(token)
  const commands = commandData()
  const result = await syncCommands({ rest: http, clientId, guildId, commands })
  console.log(describeSync(result, commands.length))
  return result
}

function applicationId(client, env, log = console) {
  const loggedIn = client.application?.id || null
  const configured = env.CLIENT_ID?.trim() || null
  if (loggedIn && configured && loggedIn !== configured) {
    const warn = typeof log.warn === 'function' ? log.warn.bind(log) : log.log.bind(log)
    warn(`CLIENT_ID ${configured} does not match the logged-in application ${loggedIn}. Command registration uses ${loggedIn}.`)
  }
  return loggedIn || configured || client.user?.id || null
}

function guildIdsOf(client) {
  return [...client.guilds.cache.keys()]
}

export function attachCommandSync(client, options = {}) {
  const env = options.env ?? process.env
  const log = options.log ?? console
  const rest = options.rest ?? new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN?.trim())
  const commands = () => options.commands ?? commandData()

  async function sync({ guildId, guildIds, ready = client } = {}) {
    try {
      const activeGuild = guildId === undefined ? readGuildId(env) : guildId
      const clientId = applicationId(ready, env, log)
      const result = await syncCommands({
        rest,
        clientId,
        guildId: activeGuild,
        guildIds: activeGuild ? [] : (guildIds ?? guildIdsOf(client)),
        commands: commands(),
      })
      log.log(describeSync(result, commands().length))
      return result
    } catch (error) {
      log.error(redact(`Command registration failed: ${error.message ?? error}`))
      return null
    }
  }

  async function onGuild(guild) {
    try {
      const guildId = readGuildId(env)
      const clientId = applicationId(client, env, log)
      if (!clientId) throw new Error('CLIENT_ID should be the numeric application id.')
      if (guildId) {
        if (guild.id !== guildId) return null
        return sync({ guildId, ready: client })
      }
      const cleared = await replaceIfChanged(rest, Routes.applicationGuildCommands(clientId, guild.id), [])
      if (cleared) log.log(`Cleared guild commands for ${guild.id}.`)
      return { scope: 'global', clearedGuilds: cleared ? [guild.id] : [] }
    } catch (error) {
      log.error(redact(`Command registration failed: ${error.message ?? error}`))
      return null
    }
  }

  client.once(Events.ClientReady, (ready) => sync({ ready }))
  client.on(Events.GuildCreate, (guild) => onGuild(guild))
  return { sync, onGuild }
}

if (isDirectRun(import.meta.url)) {
  registerCommands().catch((error) => {
    console.error(redact(error.message ?? error))
    process.exit(1)
  })
}
