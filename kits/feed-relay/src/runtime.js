import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { redact } from './env.js'
import { commitSeen, parseFeed, planFailure, selectNew } from './feed.js'
import { fetchPublic } from './ssrf.js'
import { cleanText } from './text.js'
import { inviteUrl } from './permissions.js'

const WAKE_MS = 30_000

function feedKey(guildId, id) {
  return `${guildId}:${id}`
}

function canManage(member) {
  return typeof member?.permissions?.has === 'function'
    && member.permissions.has(PermissionFlagsBits.ManageGuild)
}

async function ephemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral }
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload)
  return interaction.reply(payload)
}

export function createRuntime({
  configStore,
  store,
  now = () => Date.now(),
  fetchFeed = fetchPublic,
  fetchGuild,
  log = (message) => console.error(redact(message)),
}) {
  let bound = null
  let timer = null
  let ticking = false

  function intervalMs() {
    return configStore.get().pollIntervalSeconds * 1000
  }

  async function guildOf(guildId) {
    if (fetchGuild) return fetchGuild(guildId)
    if (!bound) throw new Error('Client is not ready.')
    return bound.guilds.fetch(guildId)
  }

  async function mark(key, mutator) {
    await store.update((data) => {
      if (!data.feeds) data.feeds = {}
      const current = data.feeds[key] ?? { seeded: false, seen: [], failures: 0, nextAttemptAt: 0 }
      data.feeds[key] = mutator(current)
    })
  }

  async function postEntry(guildId, channelId, entry) {
    const guild = await guildOf(guildId)
    if (guild.id !== guildId) throw new Error('Refusing to post outside the configured server.')
    const channel = guild.channels.cache?.get(channelId) ?? await guild.channels.fetch(channelId)
    if ((channel.guildId ?? channel.guild?.id) !== guildId) {
      throw new Error('Refusing to post outside the configured server.')
    }
    const title = cleanText(entry.title || 'Update', 180)
    const link = entry.link ? `\n${entry.link}` : ''
    await channel.send({
      content: cleanText(`${title}${link}`, 1800),
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
    })
  }

  async function pollOne(guildId, feed, allow) {
    const key = feedKey(guildId, feed.id)
    const interval = intervalMs()
    if (!allow.has(feed.channelId)) {
      await mark(key, (state) => planFailure(state, now(), new Error('destination is not on the allowlist'), interval))
      return
    }
    const snapshot = (await store.read()).feeds?.[key]
    if (snapshot && now() < (snapshot.nextAttemptAt ?? 0)) return
    let body
    try {
      body = await fetchFeed(feed.url)
    } catch (error) {
      log(`Feed ${feed.id} was not fetched: ${error.message}`)
      await mark(key, (state) => planFailure(state, now(), error, interval))
      return
    }
    let entries
    try {
      entries = parseFeed(body)
    } catch (error) {
      log(`Feed ${feed.id} was not parsed: ${error.message}`)
      await mark(key, (state) => planFailure(state, now(), error, interval))
      return
    }
    const choice = selectNew(snapshot, entries, 5)
    if (choice.seed) {
      await mark(key, (state) => commitSeen(state, {
        seed: true,
        seedIds: choice.seedIds,
        now: now(),
        intervalMs: interval,
      }))
      return
    }
    for (const entry of choice.post) {
      await postEntry(guildId, feed.channelId, entry)
      await mark(key, (state) => ({
        ...state,
        seeded: true,
        seen: [...(state.seen ?? []), entry.id].slice(-500),
        lastError: null,
      }))
    }
    await mark(key, (state) => commitSeen(state, {
      postedIds: [],
      now: now(),
      intervalMs: interval,
    }))
  }

  async function tick() {
    const config = configStore.get()
    for (const [guildId, guild] of Object.entries(config.guilds ?? {})) {
      const allow = new Set(guild.destinations ?? [])
      for (const feed of guild.feeds ?? []) {
        try {
          await pollOne(guildId, feed, allow)
        } catch (error) {
          log(`Feed ${feed.id} was not posted: ${error.message}`)
        }
      }
    }
  }

  function kick() {
    if (ticking) return
    ticking = true
    tick().catch((error) => log(redact(error.message ?? error))).finally(() => {
      ticking = false
    })
  }

  function schedule() {
    clearInterval(timer)
    timer = setInterval(kick, WAKE_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function status(interaction) {
    if (!canManage(interaction.member)) {
      await ephemeral(interaction, 'You need Manage Guild to view feed status.')
      return
    }
    const guild = configStore.get().guilds?.[interaction.guild.id]
    const data = await store.read()
    if (!guild?.feeds?.length) {
      await ephemeral(interaction, 'This server has no feeds in config.json.')
      return
    }
    const lines = guild.feeds.map((feed) => {
      const state = data.feeds?.[feedKey(interaction.guild.id, feed.id)]
      const when = state?.nextAttemptAt ? new Date(state.nextAttemptAt).toISOString() : 'soon'
      const problem = state?.lastError ? ` last error: ${cleanText(state.lastError, 80)}` : ''
      return `${feed.id}: failures ${state?.failures ?? 0}, next ${when}.${problem}`
    })
    await ephemeral(interaction, lines.join('\n').slice(0, 1800))
  }

  async function handleInteraction(interaction) {
    try {
      if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'feed') return
      if (!interaction.inGuild()) {
        await ephemeral(interaction, 'This bot only works in servers.')
        return
      }
      if (interaction.options.getSubcommand() === 'status') await status(interaction)
    } catch (error) {
      log(redact(error instanceof Error ? error.message : error))
      await ephemeral(interaction, 'Command failed.').catch(() => {})
    }
  }

  return {
    tick,
    handleInteraction,
    bind(client) {
      bound = client
      client.on(Events.InteractionCreate, (interaction) => {
        handleInteraction(interaction).catch((error) => log(redact(error.message ?? error)))
      })
      client.once(Events.ClientReady, (ready) => {
        console.log(`Logged in as ${ready.user?.tag ?? 'bot'}`)
        const clientId = process.env.CLIENT_ID?.trim()
        if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
        kick()
        schedule()
      })
      configStore.onReload(() => {
        if (timer) schedule()
      })
    },
    shutdown() {
      clearInterval(timer)
      timer = null
    },
  }
}
