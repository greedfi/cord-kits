import { ChannelType, PermissionFlagsBits } from 'discord.js'
import { createMusic } from '../src/player.js'
import { memorySessions } from '../src/sessions.js'
import { createSearchCache } from '../src/search-cache.js'

export const GUILD = '111111111111111111'
export const OTHER = '222222222222222222'
export const TEXT = '333333333333333333'
export const VOICE = '444444444444444444'

export function createManualTimers() {
  let now = 0
  let seq = 1
  const items = []
  return {
    now: () => now,
    pending: () => items.filter((item) => !item.cleared).length,
    setTimeout(fn, ms) {
      const item = { id: seq++, fn, at: now + ms, cleared: false, interval: null }
      items.push(item)
      return item.id
    },
    clearTimeout(id) {
      const item = items.find((entry) => entry.id === id)
      if (item) item.cleared = true
    },
    setInterval(fn, ms) {
      const item = { id: seq++, fn, at: now + ms, cleared: false, interval: ms }
      items.push(item)
      return item.id
    },
    clearInterval(id) {
      this.clearTimeout(id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const next = items
          .filter((item) => !item.cleared && item.at <= target)
          .sort((left, right) => left.at - right.at)[0]
        if (!next) break
        now = next.at
        if (next.interval) next.at = now + next.interval
        else next.cleared = true
        next.fn()
      }
      now = target
    },
  }
}

export function createFakeVoice() {
  const guilds = new Map()
  const handlers = { onIdle() {}, onDisconnect() {} }
  return {
    guilds,
    setHandlers(next) {
      if (next.onIdle) handlers.onIdle = next.onIdle
      if (next.onDisconnect) handlers.onDisconnect = next.onDisconnect
    },
    async join(channel) {
      const state = guilds.get(channel.guild.id) ?? { plays: [] }
      state.channelId = channel.id
      state.destroyed = false
      state.paused = false
      guilds.set(channel.guild.id, state)
      return state
    },
    async play(guildId, spec) {
      const state = guilds.get(guildId)
      if (!state || state.destroyed) throw new Error('Not connected.')
      state.plays.push(spec)
      state.paused = false
    },
    pause(guildId) {
      const state = guilds.get(guildId)
      if (state) state.paused = true
    },
    resume(guildId) {
      const state = guilds.get(guildId)
      if (state) state.paused = false
    },
    stop() {},
    setVolume() {},
    destroy(guildId) {
      const state = guilds.get(guildId)
      if (state) state.destroyed = true
      guilds.delete(guildId)
    },
    destroyAll() {
      for (const guildId of [...guilds.keys()]) this.destroy(guildId)
    },
    emitIdle(guildId) {
      handlers.onIdle(guildId)
    },
    emitDisconnect(guildId) {
      return handlers.onDisconnect(guildId)
    },
  }
}

export function voiceChannel({ id = VOICE, guildId = GUILD, allow = true } = {}) {
  return {
    id,
    type: ChannelType.GuildVoice,
    guild: { id: guildId, voiceAdapterCreator: {} },
    permissionsFor() {
      return { has: () => allow }
    },
  }
}

export function member({
  id = '10',
  roles = [],
  permissions = [],
  administrator = false,
  voice = null,
} = {}) {
  const bits = new Set(permissions.map((bit) => BigInt(bit)))
  return {
    id,
    permissions: {
      has(bit) {
        if (administrator || bits.has(PermissionFlagsBits.Administrator)) return true
        return bits.has(BigInt(bit))
      },
    },
    roles: { cache: { has: (roleId) => roles.includes(roleId) } },
    voice: voice ? { channelId: voice.id, channel: voice } : { channelId: null, channel: null },
  }
}

export function options(map = {}, subcommand = null) {
  return {
    getString: (name) => (map[name] === undefined ? null : map[name]),
    getInteger: (name) => (map[name] === undefined ? null : map[name]),
    getBoolean: (name) => (map[name] === undefined ? null : map[name]),
    getChannel: (name) => map[name] ?? null,
    getRole: (name) => map[name] ?? null,
    getAttachment: (name) => map[name] ?? null,
    getSubcommand: () => subcommand,
  }
}

export function createInteraction(overrides = {}) {
  const calls = []
  const interaction = {
    calls,
    commandName: 'play',
    deferred: false,
    replied: false,
    customId: '',
    values: [],
    guildId: GUILD,
    channelId: TEXT,
    user: { id: '10', tag: 'User#0001', username: 'User' },
    member: null,
    guild: null,
    client: { ws: { ping: 12 } },
    options: options({}),
    inGuild() { return true },
    isChatInputCommand() { return !this.isButton() && !this.isStringSelectMenu() },
    isButton() { return false },
    isStringSelectMenu() { return false },
    isRepliable() { return true },
    async reply(payload) {
      this.replied = true
      calls.push(['reply', payload])
    },
    async deferReply(payload) {
      this.deferred = true
      calls.push(['deferReply', payload])
    },
    async editReply(payload) {
      calls.push(['editReply', payload])
    },
    async followUp(payload) {
      calls.push(['followUp', payload])
    },
    async deferUpdate() {
      this.deferred = true
      calls.push(['deferUpdate'])
    },
    async update(payload) {
      this.replied = true
      calls.push(['update', payload])
    },
  }
  Object.assign(interaction, overrides)
  return interaction
}

export function configStore(initial = {}) {
  const config = {
    defaultVolume: 50,
    maxQueueSize: 100,
    autoplay: false,
    filter: 'off',
    guilds: {},
    ...initial,
  }
  return {
    config,
    get: () => config,
    update(mutator) {
      mutator(config)
      return { ok: true, config }
    },
  }
}

export function track(partial = {}) {
  return {
    kind: 'direct',
    title: 'Song',
    url: 'https://cdn.example.com/song.mp3',
    durationMs: 180_000,
    soundcloudId: null,
    requestedById: '10',
    requestedByTag: 'User',
    ...partial,
  }
}

export function musicKit(extra = {}) {
  const voice = extra.voice ?? createFakeVoice()
  const sessions = extra.sessions ?? memorySessions()
  const store = extra.store ?? configStore()
  const delays = []
  const music = createMusic(store, {
    voice,
    sessions,
    clock: extra.clock ?? Date,
    timers: extra.timers ?? globalThis,
    random: extra.random ?? Math.random,
    sleep: extra.sleep ?? (async (ms) => {
      delays.push(ms)
    }),
    maxRejoinAttempts: extra.maxRejoinAttempts ?? 5,
    resolveChannel: extra.resolveChannel ?? (async (_guildId, channelId) => voiceChannel({ id: channelId })),
    setStay: extra.setStay ?? ((guildId, enabled) => {
      store.config.guilds[guildId] = { ...store.config.guilds[guildId], stayConnected: enabled }
    }),
    status: extra.status ?? { async update() { return { ok: true } } },
    sources: extra.sources ?? {
      async stream() { return 'https://cdn.example.com/audio.mp3' },
      async related() { return [] },
    },
  })
  return { music, voice, sessions, store, delays }
}

export function searchCache() {
  return createSearchCache()
}

export const STREAM = 'https://cdn.example.com/audio.mp3'
