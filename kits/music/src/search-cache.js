import { randomBytes } from 'node:crypto'
import { SEARCH_CACHE_MAX, SEARCH_TTL_MS } from './limits.js'

export function createSearchCache({ now = () => Date.now(), ttl = SEARCH_TTL_MS, max = SEARCH_CACHE_MAX } = {}) {
  const entries = new Map()

  function prune(at) {
    for (const [token, entry] of entries) {
      if (entry.expires <= at) entries.delete(token)
    }
    while (entries.size > max) {
      const oldest = entries.keys().next().value
      entries.delete(oldest)
    }
  }

  return {
    put(guildId, userId, tracks) {
      const at = now()
      prune(at)
      const token = randomBytes(6).toString('hex')
      entries.set(token, { guildId, userId, tracks, expires: at + ttl })
      prune(at)
      return token
    },
    take(token, { guildId, userId }) {
      const entry = entries.get(token)
      if (!entry) return { error: 'missing' }
      if (entry.expires <= now()) {
        entries.delete(token)
        return { error: 'expired' }
      }
      if (entry.guildId !== guildId || entry.userId !== userId) return { error: 'owner' }
      entries.delete(token)
      return { tracks: entry.tracks }
    },
  }
}
