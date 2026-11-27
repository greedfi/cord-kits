import path from 'node:path'
import { createJsonStore } from './store.js'

function empty() {
  return { version: 1, guilds: {} }
}

function validate(data) {
  return Boolean(data && data.version === 1 && data.guilds && typeof data.guilds === 'object')
}

export function createSessionStore(filePath) {
  const store = createJsonStore(filePath, { fallback: empty, validate })
  let mirror = store.get().guilds ?? {}
  const persist = () => {
    const snapshot = structuredClone(mirror)
    return store.update((data) => {
      data.guilds = snapshot
      return data
    })
  }
  return {
    get(guildId) {
      return mirror[guildId] ? { ...mirror[guildId] } : null
    },
    all() {
      return structuredClone(mirror)
    },
    set(guildId, patch) {
      mirror = { ...mirror, [guildId]: { ...mirror[guildId], ...patch } }
      return persist()
    },
    delete(guildId) {
      const next = { ...mirror }
      delete next[guildId]
      mirror = next
      return persist()
    },
  }
}

export function memorySessions() {
  const guilds = {}
  return {
    get(guildId) {
      return guilds[guildId] ? { ...guilds[guildId] } : null
    },
    all() {
      return structuredClone(guilds)
    },
    async set(guildId, patch) {
      guilds[guildId] = { ...guilds[guildId], ...patch }
      return { ...guilds[guildId] }
    },
    async delete(guildId) {
      delete guilds[guildId]
    },
  }
}

export function sessionPath(dir) {
  return path.join(dir, 'sessions.json')
}
