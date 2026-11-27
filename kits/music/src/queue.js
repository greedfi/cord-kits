export function createQueueState(volume = 50) {
  return {
    current: null,
    tracks: [],
    previous: [],
    volume,
    loop: 'off',
    shuffle: false,
    filter: 'off',
    paused: false,
    positionMs: 0,
    startedAt: null,
    stale: false,
  }
}

export function safeLabel(value, max = 80) {
  const text = String(value ?? '')
    .replace(/[*_`~<>@]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cap = Number.isInteger(max) && max > 0 ? max : 80
  return text.slice(0, cap) || 'Untitled'
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
  return {
    ...state,
    current: null,
    tracks: [],
    previous: [],
    paused: false,
    positionMs: 0,
    startedAt: null,
    stale: false,
  }
}

export function insertManyFront(state, tracks, maxSize) {
  const room = maxSize - state.tracks.length
  if (room <= 0) {
    return {
      ok: false,
      error: 'queue_full',
      state,
      accepted: [],
      rejected: tracks.length,
    }
  }
  const accepted = tracks.slice(0, room)
  return {
    ok: true,
    error: null,
    state: { ...state, tracks: [...accepted, ...state.tracks] },
    accepted,
    rejected: tracks.length - accepted.length,
  }
}

export function removeAt(state, index) {
  if (!Number.isInteger(index) || index < 1 || index > state.tracks.length) {
    return { ok: false, error: 'range', state }
  }
  const tracks = state.tracks.slice()
  const [removed] = tracks.splice(index - 1, 1)
  return { ok: true, error: null, state: { ...state, tracks }, removed }
}

export function moveTrack(state, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
    return { ok: false, error: 'range', state }
  }
  if (from > state.tracks.length || to > state.tracks.length) {
    return { ok: false, error: 'range', state }
  }
  if (from === to) return { ok: true, error: null, state }
  const tracks = state.tracks.slice()
  const [item] = tracks.splice(from - 1, 1)
  tracks.splice(to - 1, 0, item)
  return { ok: true, error: null, state: { ...state, tracks } }
}

const LOOP_ORDER = ['off', 'song', 'queue']

export function setLoop(state, mode) {
  if (!LOOP_ORDER.includes(mode)) throw new RangeError('Loop must be song, queue, or off.')
  return { ...state, loop: mode }
}

export function cycleLoop(state) {
  const index = LOOP_ORDER.indexOf(state.loop)
  const loop = LOOP_ORDER[(index + 1) % LOOP_ORDER.length]
  return { ...state, loop }
}

export function toggleShuffle(state, random = Math.random) {
  if (state.shuffle) return { ...state, shuffle: false }
  const tracks = state.tracks.slice()
  for (let index = tracks.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const current = tracks[index]
    tracks[index] = tracks[swap]
    tracks[swap] = current
  }
  return { ...state, tracks, shuffle: true }
}

export function pushPrevious(state, track, cap = 50) {
  if (!track) return state.previous ?? []
  return [...(state.previous ?? []), track].slice(-cap)
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
