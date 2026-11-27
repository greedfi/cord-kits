function keysOf(track) {
  const keys = []
  if (track?.url) keys.push(String(track.url))
  if (track?.soundcloudId != null) keys.push(String(track.soundcloudId))
  return keys
}

export function pickRelated(candidates, { current = null, waiting = [], previous = [], seen = [] } = {}) {
  const blocked = new Set()
  for (const track of [current, ...waiting, ...previous]) {
    for (const key of keysOf(track)) blocked.add(key)
  }
  for (const key of seen) blocked.add(String(key))
  for (const candidate of candidates ?? []) {
    const keys = keysOf(candidate)
    if (keys.length === 0) continue
    if (keys.some((key) => blocked.has(key))) continue
    return candidate
  }
  return null
}
