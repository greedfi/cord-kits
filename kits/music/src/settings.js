export const STANDARD_QUEUE_CAP = 100
export const HARD_QUEUE_CAP = 1000

export function guildSettings(config, guildId) {
  const guild = config.guilds?.[guildId] ?? {}
  return {
    defaultVolume: guild.defaultVolume ?? config.defaultVolume,
    maxQueueSize: guild.maxQueueSize ?? config.maxQueueSize,
    extendedQueue: guild.extendedQueue ?? config.extendedQueue,
    autoplay: guild.autoplay ?? config.autoplay,
    stayConnected: guild.stayConnected ?? config.stayConnected,
    filter: guild.filter ?? config.filter,
    djRoleId: guild.djRoleId ?? null,
    djOnly: guild.djOnly ?? [],
    textChannels: guild.textChannels ?? [],
    voiceChannels: guild.voiceChannels ?? [],
    requestChannelId: guild.requestChannelId ?? null,
    requestAutoDelete: guild.requestAutoDelete ?? false,
    requestCommandsOnly: guild.requestCommandsOnly ?? false,
  }
}

export function waitingLimit(settings) {
  const configured = Number.isInteger(settings.maxQueueSize) ? settings.maxQueueSize : STANDARD_QUEUE_CAP
  const ceiling = settings.extendedQueue ? HARD_QUEUE_CAP : STANDARD_QUEUE_CAP
  return Math.max(1, Math.min(configured, ceiling, HARD_QUEUE_CAP))
}
