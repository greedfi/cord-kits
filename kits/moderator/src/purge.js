export const PURGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export function selectPurgeMessages(messages, { userId, now, limit, maxAgeMs = PURGE_MAX_AGE_MS }) {
  const sorted = [...messages].sort((a, b) => b.createdAt - a.createdAt)
  const picked = []
  for (const message of sorted) {
    if (picked.length >= limit) break
    if (userId && message.authorId !== userId) continue
    if (now - message.createdAt >= maxAgeMs) continue
    picked.push(message)
  }
  return picked
}
