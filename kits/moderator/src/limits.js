export function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Rate limit must be a positive integer.')
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error('Rate limit window must be a positive integer.')
  const buckets = new Map()
  return {
    take(key) {
      const time = now()
      const bucket = buckets.get(key) ?? { hits: [], blockedNotice: null }
      bucket.hits = bucket.hits.filter((ts) => time - ts < windowMs)
      if (bucket.hits.length >= limit) {
        const notify = bucket.blockedNotice == null || time - bucket.blockedNotice >= windowMs
        if (notify) bucket.blockedNotice = time
        buckets.set(key, bucket)
        return { allowed: false, notify }
      }
      bucket.hits.push(time)
      buckets.set(key, bucket)
      return { allowed: true, notify: false }
    },
  }
}
