import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js'
import { handleAutomod } from './automod.js'
import { configFilePath, createConfigStore, createLogger, loadSchema } from './config.js'
import { execute } from './dispatch.js'
import { isDirectRun, loadEnv, redact, requireEnv } from './env.js'
import { assessJoinHoldRole, assessJoinHoldTimeout } from './guard.js'
import { createRateLimiter } from './limits.js'
import { dataDirectory } from './paths.js'
import { inviteUrl } from './permissions.js'
import { applyRaidChanges, createRaidSync, desiredSlowmodes, joinHoldAction } from './raid.js'
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
    return false
  }
  try {
    await channel.setRateLimitPerUser(seconds, 'Raid mode')
    return true
  } catch (error) {
    console.error(`Raid mode slowmode failed for ${channelId}: ${error.message}`)
    return false
  }
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
  const dataDir = dataDirectory()
  const warnings = createWarningStore(path.join(dataDir, 'warnings.json'))
  const raid = createRaidSync({ filePath: path.join(dataDir, 'raid-snapshots.json') })
  const filterLimiter = createRateLimiter({ limit: 6, windowMs: 10_000 })
  const commandLimiter = createRateLimiter({ limit: 5, windowMs: 15_000 })
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
    const prior = new Map([...known].map(([id, entry]) => [id, { ...entry }]))
    const preview = raid.preview(guild.id, desired, (id) => previous.get(id) ?? 0)
    const applied = await applyRaidChanges({
      prior,
      preview,
      setSlowmode: (id, seconds) => setSlowmode(guild, id, seconds),
    })
    raid.commit(guild.id, applied.state)
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
    const settings = message.guild ? config.get().guilds?.[message.guild.id] : null
    handleAutomod(message, {
      settings,
      limiter: filterLimiter,
      fetchMember: (userId) => message.guild.members.fetch(userId).catch(() => null),
      log: (text) => sendLog(message.guild, settings, text),
    }).catch((error) => console.error(redact(error)))
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
        const assessment = assessJoinHoldTimeout({
          botHasModerate: me.permissions.has(PermissionFlagsBits.ModerateMembers),
          member,
          botId: me.id,
          ownerId: member.guild.ownerId,
          botHighest: me.roles.highest.position,
        })
        if (!assessment.ok) {
          console.error(`Raid join hold did not time out ${member.id}: ${assessment.reason}.`)
          return
        }
        await member.timeout(action.timeoutMs, 'Raid mode join hold')
        await sendLog(member.guild, settings, `join-hold: timed out ${member.user.tag} (${member.id}) for ${action.minutes} minute(s).`)
        return
      }
      if (action.type === 'role') {
        const role = await member.guild.roles.fetch(action.roleId).catch(() => null)
        const assessment = assessJoinHoldRole(role, {
          botHasManageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
          botHighest: me.roles.highest.position,
          guildId: member.guild.id,
        })
        if (!assessment.ok) {
          console.error(`Raid join hold did not assign ${action.roleId}: ${assessment.reason}.`)
          return
        }
        await member.roles.add(role, 'Raid mode join hold')
        await sendLog(member.guild, settings, `join-hold: gave ${member.user.tag} (${member.id}) the role ${role.name} (${role.id}).`)
      }
    })().catch((error) => console.error(redact(error)))
  })

  client.on(Events.InteractionCreate, (interaction) => {
    execute(interaction, { configStore: config, warnings, commandLimiter }).catch((error) => {
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
