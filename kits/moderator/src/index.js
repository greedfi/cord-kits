import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js'
import { configFilePath, createConfigStore, createLogger, loadSchema } from './config.js'
import { execute } from './dispatch.js'
import { isDirectRun, loadEnv, redact, requireEnv } from './env.js'
import { messageViolation } from './filters.js'
import { inviteUrl } from './permissions.js'
import { createRaidSync, desiredSlowmodes, joinHoldAction } from './raid.js'
import { cleanText } from './text.js'
import { createWarningStore } from './warnings.js'

const kitRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function sendLog(guild, settings, text) {
  const channelId = settings?.modLogChannelId
  if (!channelId) return
  const channel = guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null)
  if (!channel?.isTextBased?.()) return
  await channel.send(cleanText(text, 1900)).catch((error) => {
    console.error(`Mod log failed: ${error.message}`)
  })
}

async function setSlowmode(guild, channelId, seconds) {
  const channel = guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null)
  if (!channel || typeof channel.setRateLimitPerUser !== 'function') {
    console.error(`Raid mode: channel ${channelId} does not support slowmode.`)
    return
  }
  await channel.setRateLimitPerUser(seconds, 'Raid mode').catch((error) => {
    console.error(`Raid mode slowmode failed for ${channelId}: ${error.message}`)
  })
}

export async function main() {
  loadEnv()
  const token = requireEnv('DISCORD_BOT_TOKEN')
  const filePath = configFilePath()
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. Copy config.example.json to config.json and edit it.`)
  }
  const config = createConfigStore({
    filePath,
    schema: loadSchema(path.join(kitRoot, 'config.schema.json')),
    logger: createLogger(),
  })
  const warnings = createWarningStore(path.join(process.cwd(), 'data', 'warnings.json'))
  const raid = createRaidSync({ filePath: path.join(process.cwd(), 'data', 'raid-snapshots.json') })
  let ready = false

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  })

  async function syncGuild(guild) {
    const raidMode = config.get().guilds?.[guild.id]?.raidMode
    const desired = desiredSlowmodes(raidMode)
    const known = raid.state(guild.id)
    const previous = new Map()
    for (const id of desired.keys()) {
      if (known.has(id)) continue
      const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null)
      previous.set(id, typeof channel?.rateLimitPerUser === 'number' ? channel.rateLimitPerUser : 0)
    }
    const result = raid.plan(guild.id, desired, (id) => previous.get(id) ?? 0)
    for (const change of result.changes) {
      await setSlowmode(guild, change.id, change.slowmodeSeconds)
    }
  }

  async function syncAll() {
    if (!ready) return
    const ids = new Set([
      ...client.guilds.cache.keys(),
      ...Object.keys(config.get().guilds ?? {}),
    ])
    for (const guildId of ids) {
      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null)
      if (!guild) continue
      await syncGuild(guild).catch((error) => {
        console.error(`Raid sync failed for ${guildId}: ${error.message}`)
      })
    }
  }

  client.on(Events.MessageCreate, (message) => {
    if (!message.guild || message.author.bot || !message.content) return
    const settings = config.get().guilds?.[message.guild.id]
    const hit = messageViolation(message.content, settings)
    if (!hit) return
    ;(async () => {
      if (message.deletable) {
        await message.delete().catch((error) => {
          console.error(`Filter delete failed: ${error.message}`)
        })
      } else {
        console.error('Missing Manage Messages; a filtered message was left in place.')
      }
      await sendLog(
        message.guild,
        settings,
        `filter: deleted a message from ${message.author.tag} (${message.author.id}) in <#${message.channel.id}> (${hit.type}: ${hit.detail}).`,
      )
    })().catch((error) => console.error(redact(error)))
  })

  client.on(Events.GuildMemberAdd, (member) => {
    if (member.user.bot) return
    const settings = config.get().guilds?.[member.guild.id]
    const action = joinHoldAction(settings?.raidMode)
    if (action.type === 'off') return
    ;(async () => {
      const me = member.guild.members.me ?? await member.guild.members.fetchMe()
      if (action.type === 'error') {
        console.error('Raid mode role hold is missing roleId.')
        return
      }
      if (action.type === 'timeout') {
        if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
          console.error('Raid join hold needs Moderate Members.')
          return
        }
        await member.timeout(action.timeoutMs, 'Raid mode join hold')
        await sendLog(member.guild, settings, `join-hold: timed out ${member.user.tag} (${member.id}) for ${action.minutes} minute(s).`)
        return
      }
      if (action.type === 'role') {
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
          console.error('Raid join hold needs Manage Roles.')
          return
        }
        const role = await member.guild.roles.fetch(action.roleId).catch(() => null)
        if (!role) {
          console.error(`Raid role ${action.roleId} was not found.`)
          return
        }
        if (role.position >= me.roles.highest.position) {
          console.error(`Move the bot role above ${role.id} before raid mode can assign it.`)
          return
        }
        await member.roles.add(role, 'Raid mode join hold')
        await sendLog(member.guild, settings, `join-hold: gave ${member.user.tag} (${member.id}) the role ${role.name} (${role.id}).`)
      }
    })().catch((error) => console.error(redact(error)))
  })

  client.on(Events.InteractionCreate, (interaction) => {
    execute(interaction, { configStore: config, warnings }).catch((error) => {
      console.error(redact(error))
    })
  })

  config.onReload(() => {
    syncAll().catch((error) => console.error(redact(error)))
  })

  client.once(Events.ClientReady, (readyClient) => {
    ready = true
    console.log(`Logged in as ${readyClient.user.tag}`)
    const clientId = process.env.CLIENT_ID?.trim()
    if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
    syncAll().catch((error) => console.error(redact(error)))
  })

  const shutdown = () => {
    config.close()
    client.destroy()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await client.login(token)
  return { client, config }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    console.error(redact(error.message ?? error))
    process.exit(1)
  })
}
