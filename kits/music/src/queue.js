const HISTORY_LIMIT = 25

export function createQueueState(volume = 50) {
  return {
    current: null,
    tracks: [],
    history: [],
    volume,
    loop: 'off',
    filter: 'off',
    paused: false,
    offsetMs: 0,
    startedAt: null,
  }
}

export function safeLabel(value, max = 80) {
  const text = String(value ?? '')
    .replace(/<@!?\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/@everyone/gi, '')
    .replace(/@here/gi, '')
    .replace(/[*_`~|<>@\\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, max) || 'Untitled'
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

export function insertFront(state, tracks, maxSize) {
  const room = maxSize - state.tracks.length
  if (room <= 0) {
    return { ok: false, error: 'queue_full', state, accepted: [], rejected: tracks.length }
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

export function replaceCurrent(state, tracks, maxSize) {
  if (tracks.length === 0) {
    return { ok: false, error: 'empty', state, accepted: [], rejected: 0 }
  }
  const [first, ...rest] = tracks
  const history = state.current
    ? [...state.history, state.current].slice(-HISTORY_LIMIT)
    : state.history
  const room = Math.max(0, maxSize - state.tracks.length)
  const acceptedRest = rest.slice(0, room)
  return {
    ok: true,
    error: null,
    state: {
      ...state,
      current: first,
      history,
      tracks: [...acceptedRest, ...state.tracks],
      offsetMs: 0,
      paused: false,
      startedAt: null,
    },
    accepted: [first, ...acceptedRest],
    rejected: rest.length - acceptedRest.length,
  }
}

export function promote(state) {
  if (state.tracks.length === 0) {
    return { state: { ...state, current: null }, track: null }
  }
  const [track, ...tracks] = state.tracks
  return { state: { ...state, current: track, tracks }, track }
}

export function finishCurrent(state, { natural }) {
  if (!state.current) {
    const promoted = promote(state)
    return {
      state: { ...promoted.state, offsetMs: 0, paused: false, startedAt: null },
      track: promoted.track,
      autoplay: Boolean(natural) && promoted.track == null,
    }
  }
  if (natural && state.loop === 'song' && !state.current.failed) {
    const current = { ...state.current, failed: false }
    return {
      state: { ...state, current, offsetMs: 0, paused: false, startedAt: null },
      track: current,
      autoplay: false,
    }
  }
  if (natural && state.loop === 'queue' && !state.current.failed) {
    const replayed = { ...state.current, failed: false }
    const rotated = promote({
      ...state,
      tracks: [...state.tracks, replayed],
      current: null,
    })
    return {
      state: { ...rotated.state, offsetMs: 0, paused: false, startedAt: null },
      track: rotated.track,
      autoplay: rotated.track == null,
    }
  }
  const history = [...state.history, state.current].slice(-HISTORY_LIMIT)
  const promoted = promote({ ...state, current: null, history })
  return {
    state: { ...promoted.state, offsetMs: 0, paused: false, startedAt: null },
    track: promoted.track,
    autoplay: Boolean(natural) && promoted.track == null,
  }
}

export function back(state, maxSize = Number.POSITIVE_INFINITY) {
  if (state.history.length === 0) return { ok: false, error: 'no_history', state }
  const track = { ...state.history[state.history.length - 1], failed: false }
  const history = state.history.slice(0, -1)
  const tracks = state.current ? [state.current, ...state.tracks] : state.tracks.slice()
  if (tracks.length > maxSize) return { ok: false, error: 'queue_full', state }
  return {
    ok: true,
    track,
    state: {
      ...state,
      history,
      current: track,
      tracks,
      offsetMs: 0,
      paused: false,
      startedAt: null,
    },
  }
}

export function stop(state) {
  return { ...state, current: null, tracks: [], offsetMs: 0, paused: false, startedAt: null }
}

export function clearWaiting(state) {
  return { ...state, tracks: [] }
}

export function moveTrack(tracks, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { ok: false, error: 'bad_index', tracks }
  if (from < 1 || to < 1 || from > tracks.length || to > tracks.length) {
    return { ok: false, error: 'bad_index', tracks }
  }
  if (from === to) return { ok: true, tracks }
  const next = tracks.slice()
  const [item] = next.splice(from - 1, 1)
  next.splice(to - 1, 0, item)
  return { ok: true, tracks: next }
}

export function removeAt(tracks, index) {
  if (!Number.isInteger(index) || index < 1 || index > tracks.length) {
    return { ok: false, error: 'bad_index', tracks }
  }
  const next = tracks.slice()
  const [removed] = next.splice(index - 1, 1)
  return { ok: true, tracks: next, removed }
}

export function shuffleTracks(tracks, random = Math.random) {
  const next = tracks.slice()
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const item = next[index]
    next[index] = next[swap]
    next[swap] = item
  }
  return next
}

export function seekTo(state, positionMs) {
  if (!state.current) return { ok: false, error: 'idle', state }
  if (state.current.kind === 'radio' || !Number.isFinite(state.current.durationMs)) {
    return { ok: false, error: 'unseekable', state }
  }
  if (!Number.isFinite(positionMs) || positionMs < 0) return { ok: false, error: 'bad_position', state }
  if (positionMs >= state.current.durationMs) return { ok: false, error: 'past_end', state }
  return {
    ok: true,
    state: { ...state, offsetMs: positionMs, paused: false, startedAt: null },
  }
}

export function setVolume(state, volume) {
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new RangeError('Volume must be an integer from 0 to 100')
  }
  return { ...state, volume }
}

export function parseClock(value) {
  const text = String(value ?? '').trim()
  if (!/^\d{1,5}(?::\d{1,2}){0,2}$/.test(text)) return null
  const parts = text.split(':').map(Number)
  if (parts.length === 1) {
    if (parts[0] > 24 * 60 * 60) return null
    return parts[0] * 1000
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts
    if (seconds > 59 || minutes > 24 * 60) return null
    return (minutes * 60 + seconds) * 1000
  }
  const [hours, minutes, seconds] = parts
  if (hours > 24 || minutes > 59 || seconds > 59) return null
  return (hours * 3600 + minutes * 60 + seconds) * 1000
}

export function formatQueue(state, { limit = 10 } = {}) {
  const lines = []
  if (state.current) lines.push(`Now playing: ${safeLabel(state.current.title || state.current.url)}`)
  else lines.push('Now playing: nothing')
  lines.push(`Volume: ${state.volume}%`)
  if (state.loop && state.loop !== 'off') lines.push(`Loop: ${state.loop}`)
  if (state.paused) lines.push('Paused')
  if (state.tracks.length === 0) {
    lines.push('Queue is empty.')
    return lines.join('\n').slice(0, 2000)
  }
  state.tracks.slice(0, limit).forEach((track, index) => {
    const who = track.requestedByTag ? ` — ${safeLabel(track.requestedByTag)}` : ''
    lines.push(`${index + 1}. ${safeLabel(track.title || track.url)}${who}`)
  })
  if (state.tracks.length > limit) lines.push(`…and ${state.tracks.length - limit} more`)
  return lines.join('\n').slice(0, 2000)
}

export function playedMs(state, now, rate = 1) {
  if (!state?.current) return 0
  const elapsed = state.paused || state.startedAt == null ? 0 : (now - state.startedAt) * rate
  const position = state.offsetMs + elapsed
  if (Number.isFinite(state.current.durationMs)) {
    return Math.min(Math.max(0, position), state.current.durationMs)
  }
  return Math.max(0, position)
}
