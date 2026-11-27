import { FILTER_NAMES, HARD_QUEUE_CAP } from './limits.js'

export function patchGuild(configStore, guildId, patch) {
  return configStore.update((draft) => {
    const next = { ...draft.guilds?.[guildId] }
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) delete next[key]
      else next[key] = value
    }
    if (!draft.guilds) draft.guilds = {}
    if (Object.keys(next).length === 0) delete draft.guilds[guildId]
    else draft.guilds[guildId] = next
  })
}

export function guildSettings(config, guildId) {
  const guild = config?.guilds?.[guildId] ?? {}
  const maxQueueSize = guild.maxQueueSize ?? config?.maxQueueSize ?? 100
  const filter = guild.filter ?? config?.filter ?? 'off'
  return {
    defaultVolume: guild.defaultVolume ?? config?.defaultVolume ?? 50,
    maxQueueSize: Math.min(HARD_QUEUE_CAP, Math.max(1, maxQueueSize)),
    autoplay: guild.autoplay ?? config?.autoplay ?? false,
    stayConnected: guild.stayConnected ?? false,
    filter: FILTER_NAMES.includes(filter) ? filter : 'off',
    djRoleId: guild.djRoleId ?? null,
    djOnly: Array.isArray(guild.djOnly) ? guild.djOnly : [],
    textLock: guild.textLock ?? false,
    textChannels: Array.isArray(guild.textChannels) ? guild.textChannels : [],
    voiceLock: guild.voiceLock ?? false,
    voiceChannels: Array.isArray(guild.voiceChannels) ? guild.voiceChannels : [],
    requestChannelId: guild.requestChannelId ?? null,
    requestAutoDelete: guild.requestAutoDelete ?? false,
    requestCommandsOnly: guild.requestCommandsOnly ?? false,
  }
}
