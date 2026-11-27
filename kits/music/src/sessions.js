import fs from 'node:fs'
import { readJsonFile, writeJsonAtomic } from './store.js'

export function rejoinDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError('attempt must be a non-negative integer')
  }
  const power = Math.min(attempt, 5)
  return Math.min(30_000, 1000 * (2 ** power))
}

export function createStateStore(file, fsImpl = fs) {
  let data = readJsonFile(file, fsImpl) ?? { guilds: {} }
  if (!data || typeof data !== 'object' || !data.guilds || typeof data.guilds !== 'object') {
    data = { guilds: {} }
  }

  function commit(next) {
    writeJsonAtomic(file, next, fsImpl)
    data = next
  }

  return {
    get(guildId) {
      return data.guilds[guildId] ?? null
    },
    put(guildId, patch) {
      commit({
        guilds: {
          ...data.guilds,
          [guildId]: { ...data.guilds[guildId], ...patch },
        },
      })
    },
    all() {
      return data.guilds
    },
  }
}
