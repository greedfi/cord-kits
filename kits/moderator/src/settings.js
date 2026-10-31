export function defaultGuildSettings() {
  return {
    modLogChannelId: null,
    wordFilter: {
      enabled: false,
      match: 'word',
      words: [],
    },
    linkFilter: {
      enabled: false,
      mode: 'blocklist',
      domains: [],
      allowSubdomains: true,
    },
    raidMode: {
      enabled: false,
      slowmodeSeconds: 10,
      channelIds: [],
      joinHold: {
        type: 'timeout',
        timeoutMinutes: 10,
        roleId: null,
      },
    },
  }
}

export function setRaidEnabled(config, guildId, enabled) {
  if (!/^[0-9]{17,20}$/.test(guildId)) {
    throw new Error('Guild id is not a snowflake.')
  }
  const next = structuredClone(config)
  if (!next.guilds[guildId]) next.guilds[guildId] = defaultGuildSettings()
  next.guilds[guildId].raidMode.enabled = Boolean(enabled)
  return next
}
