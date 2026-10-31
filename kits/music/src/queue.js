export function createQueueState(volume = 50) {
  return { current: null, tracks: [], volume }
}

export function safeLabel(value) {
  const text = String(value ?? '')
    .replace(/[*_`~<>@]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 80) || 'Untitled'
}

export function enqueue(state, track, maxSize) {
  if (state.tracks.length >= maxSize) {
    return { ok: false, error: 'queue_full', state }
  }
  return {
    ok: true,
    state: { ...state, tracks: [...state.tracks, track] },
  }
}

export function enqueueMany(state, tracks, maxSize) {
  let current = state
  const accepted = []
  for (const track of tracks) {
    const result = enqueue(current, track, maxSize)
    if (!result.ok) {
      return {
        ok: accepted.length > 0,
        error: accepted.length > 0 ? null : 'queue_full',
        state: current,
        accepted,
        rejected: tracks.length - accepted.length,
      }
    }
    current = result.state
    accepted.push(track)
  }
  return { ok: true, error: null, state: current, accepted, rejected: 0 }
}

export function promote(state) {
  if (state.tracks.length === 0) {
    return { state: { ...state, current: null }, track: null }
  }
  const [track, ...tracks] = state.tracks
  return { state: { ...state, current: track, tracks }, track }
}

export function skip(state) {
  return promote({ ...state, current: null })
}

export function stop(state) {
  return { ...state, current: null, tracks: [] }
}

export function setVolume(state, volume) {
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new RangeError('Volume must be an integer from 0 to 100')
  }
  return { ...state, volume }
}

export function createGuildQueues(defaultVolume = 50) {
  const queues = new Map()
  return {
    get(guildId) {
      if (!queues.has(guildId)) queues.set(guildId, createQueueState(defaultVolume))
      return queues.get(guildId)
    },
    set(guildId, state) {
      queues.set(guildId, state)
      return state
    },
    has(guildId) {
      return queues.has(guildId)
    },
  }
}

export function formatQueue(state, { limit = 10 } = {}) {
  const lines = []
  if (state.current) lines.push(`Now playing: ${safeLabel(state.current.title || state.current.url)}`)
  else lines.push('Now playing: nothing')
  lines.push(`Volume: ${state.volume}%`)
  if (state.tracks.length === 0) {
    lines.push('Queue is empty.')
    return lines.join('\n')
  }
  state.tracks.slice(0, limit).forEach((track, index) => {
    const who = track.requestedByTag ? ` — ${safeLabel(track.requestedByTag)}` : ''
    lines.push(`${index + 1}. ${safeLabel(track.title || track.url)}${who}`)
  })
  if (state.tracks.length > limit) {
    lines.push(`…and ${state.tracks.length - limit} more`)
  }
  return lines.join('\n')
}
