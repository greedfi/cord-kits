import { PermissionFlagsBits, PermissionsBitField } from 'discord.js'

export function memoryConfig(initial) {
  let current = structuredClone(initial)
  return {
    get: () => current,
    update(mutator) {
      const draft = structuredClone(current)
      mutator(draft)
      current = draft
      return { ok: true, config: current }
    },
    close() {},
  }
}

function optionsOf(map) {
  return {
    getString(name) {
      return map[name] ?? null
    },
    getInteger(name) {
      return map[name] ?? null
    },
    getBoolean(name) {
      return map[name] ?? null
    },
    getAttachment(name) {
      return map[name] ?? null
    },
    getRole(name) {
      return map[name] ?? null
    },
    getChannel(name) {
      return map[name] ?? null
    },
    getSubcommand(required = true) {
      if (map.subcommand) return map.subcommand
      if (!required) return null
      throw new Error('missing subcommand')
    },
  }
}

export function mockInteraction(overrides = {}) {
  const replies = []
  const permissions = new PermissionsBitField(overrides.permissions ?? [PermissionFlagsBits.Connect])
  const voiceChannel = overrides.voiceChannel === undefined ? {
    id: '444444444444444444',
    type: 2,
    permissionsFor() {
      return new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ])
    },
  } : overrides.voiceChannel
  const interaction = {
    commandName: overrides.commandName ?? 'ping',
    customId: overrides.customId ?? null,
    values: overrides.values ?? [],
    replied: false,
    deferred: false,
    guildId: overrides.guildId ?? '111111111111111111',
    channelId: overrides.channelId ?? '222222222222222222',
    createdTimestamp: overrides.createdTimestamp ?? 1_000,
    user: { id: overrides.userId ?? '333333333333333333', username: overrides.username ?? 'ada' },
    member: {
      permissions,
      roles: { cache: { has: (id) => (overrides.roles ?? []).includes(id) } },
      voice: { channel: voiceChannel, channelId: voiceChannel?.id ?? null },
    },
    options: optionsOf(overrides.options ?? {}),
    client: { ws: { ping: 42 } },
    isChatInputCommand: () => overrides.kind !== 'button' && overrides.kind !== 'select',
    isButton: () => overrides.kind === 'button',
    isStringSelectMenu: () => overrides.kind === 'select',
    inGuild: () => overrides.inGuild !== false,
    async reply(payload) {
      this.replied = true
      replies.push({ type: 'reply', payload })
    },
    async deferReply() {
      this.deferred = true
      replies.push({ type: 'defer' })
    },
    async editReply(payload) {
      this.replied = true
      replies.push({ type: 'edit', payload })
    },
    async deferUpdate() {
      this.deferred = true
      replies.push({ type: 'deferUpdate' })
    },
    async followUp(payload) {
      replies.push({ type: 'follow', payload })
    },
    async fetchReply() {
      return { id: '777777777777777777', channelId: this.channelId }
    },
  }
  interaction.guild = {
    id: interaction.guildId,
    members: { me: { id: '999999999999999999', voice: { channelId: overrides.botChannelId ?? null } } },
    channels: {
      cache: { get: () => overrides.fetchedChannel ?? null },
      fetch: async () => overrides.fetchedChannel ?? null,
    },
  }
  return { interaction, replies }
}

export function stubMusic(snapshot) {
  const calls = []
  const state = snapshot ?? {
    current: { title: 'Song', url: 'https://cdn.example.com/a.mp3', durationMs: 60_000 },
    tracks: [],
    history: [],
    volume: 50,
    loop: 'off',
    filter: 'off',
    paused: false,
    connected: true,
    offsetMs: 0,
    startedAt: null,
  }
  return new Proxy({ calls, snapshot: () => state }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return async (...args) => {
        calls.push([prop, ...args])
        return { ok: true, message: `${String(prop)} ok` }
      }
    },
  })
}

export const baseConfig = {
  defaultVolume: 50,
  maxQueueSize: 100,
  extendedQueue: false,
  autoplay: false,
  stayConnected: false,
  filter: 'off',
  guilds: {
    '111111111111111111': {
      djRoleId: '555555555555555555',
      djOnly: ['skip', 'stop'],
    },
  },
}
