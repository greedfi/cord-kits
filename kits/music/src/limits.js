export const HARD_QUEUE_CAP = 1000
export const MAX_SCRIPT_URLS = 30
export const MAX_SCRIPT_BYTES = 4_000_000
export const SCRIPT_TIMEOUT_MS = 8_000
export const PROGRESS_MS = 15_000
export const HISTORY_CAP = 50
export const SEEN_CAP = 50
export const MAX_PLAYLISTS = 25
export const MAX_PLAYLIST_TRACKS = 100
export const MAX_SHARES = 25
export const MAX_SEEK_MS = 24 * 60 * 60 * 1000
export const MAX_REJOIN_ATTEMPTS = 100
export const SEARCH_TTL_MS = 60_000
export const SEARCH_CACHE_MAX = 100
export const SEARCH_RESULTS = 10
export const REQUEST_TEXT_MAX = 200

export const LOOP_MODES = ['off', 'song', 'queue']
export const FILTER_NAMES = ['off', 'bassboost', 'nightcore', '8d']

export function backoffMs(attempt) {
  const step = Math.max(0, attempt)
  return Math.min(1000 * (2 ** step), 60_000)
}
