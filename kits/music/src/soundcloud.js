import { MAX_SCRIPT_BYTES, MAX_SCRIPT_URLS, SCRIPT_TIMEOUT_MS } from './limits.js'
import { SourceError, assertPublicHttpUrl } from './sources.js'

const USER_AGENT = 'cord-kits-music/0.1'
let cachedClientId = null

export function clearClientIdCache() {
  cachedClientId = null
}

export function extractScriptUrls(html) {
  const urls = new Set()
  const pattern = /(?:https:)?\/\/[^"'\\\s>]+\.js/g
  for (const match of String(html).matchAll(pattern)) {
    let url = match[0]
    if (url.startsWith('//')) url = `https:${url}`
    if (!url.startsWith('https://')) continue
    if (url.includes('sndcdn.com') || url.includes('soundcloud.com')) urls.add(url)
  }
  return [...urls]
}

export function extractClientId(source) {
  const text = String(source)
  const patterns = [
    /client_id\s*:\s*"([0-9a-zA-Z]{32})"/,
    /client_id=([0-9a-zA-Z]{32})/,
    /"clientId"\s*:\s*"([0-9a-zA-Z]{32})"/,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[1]
  }
  return null
}

function mapTrack(track, pageUrl) {
  if (!track || typeof track !== 'object') return null
  const url = track.permalink_url || pageUrl || null
  if (!url) return null
  let artworkUrl = null
  if (typeof track.artwork_url === 'string') {
    try {
      const parsed = assertPublicHttpUrl(track.artwork_url)
      if (parsed.hostname === 'sndcdn.com' || parsed.hostname.endsWith('.sndcdn.com')) {
        artworkUrl = parsed.toString()
      }
    } catch {
      artworkUrl = null
    }
  }
  return {
    kind: 'soundcloud',
    title: track.title || 'SoundCloud track',
    url,
    durationMs: Number.isFinite(track.duration) ? track.duration : null,
    soundcloudId: track.id == null ? null : String(track.id),
    artworkUrl,
  }
}

export function tracksFromResolve(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (payload.kind === 'track' || Array.isArray(payload.media?.transcodings)) return [payload]
  if (Array.isArray(payload.tracks)) {
    return payload.tracks.filter((track) => track && typeof track === 'object')
  }
  return []
}

export function pickTranscoding(track) {
  const list = Array.isArray(track?.media?.transcodings) ? track.media.transcodings : []
  return list.find((item) => item?.format?.protocol === 'progressive' && item.url)
    ?? list.find((item) => item?.format?.protocol === 'hls' && item.url)
    ?? null
}

export function planSoundCloudTracks(payload, pageUrl, maxTracks = 10) {
  return tracksFromResolve(payload)
    .map((track) => mapTrack(track, pageUrl))
    .filter(Boolean)
    .slice(0, maxTracks)
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  return undefined
}

export async function discoverClientId(fetchImpl = fetch, options = {}) {
  const limit = options.limit ?? MAX_SCRIPT_URLS
  const maxBytes = options.maxBytes ?? MAX_SCRIPT_BYTES
  const home = await fetchImpl('https://soundcloud.com/', {
    headers: { 'User-Agent': USER_AGENT },
    signal: timeoutSignal(SCRIPT_TIMEOUT_MS),
  })
  if (!home.ok) return null
  const html = await home.text()
  const scripts = extractScriptUrls(html).slice(0, limit)
  for (const scriptUrl of scripts) {
    const response = await fetchImpl(scriptUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: timeoutSignal(SCRIPT_TIMEOUT_MS),
    })
    if (!response.ok) continue
    const length = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(length) && length > maxBytes) continue
    const text = await response.text()
    if (text.length > maxBytes) {
      const clientId = extractClientId(text.slice(0, maxBytes))
      if (clientId) return clientId
      continue
    }
    const clientId = extractClientId(text)
    if (clientId) return clientId
  }
  return null
}

function lockedClientId(explicit) {
  if (explicit) return explicit
  const fromEnv = process.env.SOUNDCLOUD_CLIENT_ID?.trim()
  if (fromEnv) return fromEnv
  return null
}

export async function getClientId(fetchImpl = fetch, override, options = {}) {
  const locked = lockedClientId(override)
  if (locked) return locked
  if (!options.refresh && cachedClientId) return cachedClientId
  cachedClientId = null
  const discovered = await discoverClientId(fetchImpl, options)
  if (discovered) cachedClientId = discovered
  return discovered
}

async function fetchJson(fetchImpl, url, { refresh }) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  const response = await fetchImpl(String(url), { headers, signal: timeoutSignal(SCRIPT_TIMEOUT_MS) })
  if ((response.status === 401 || response.status === 403) && refresh) {
    clearClientIdCache()
    const next = await discoverClientId(fetchImpl)
    if (next) {
      cachedClientId = next
      const retry = new URL(String(url))
      retry.searchParams.set('client_id', next)
      const second = await fetchImpl(retry, { headers, signal: timeoutSignal(SCRIPT_TIMEOUT_MS) })
      if (!second.ok) throw new SourceError('soundcloud', `SoundCloud request failed (${second.status}).`)
      return second.json()
    }
  }
  if (!response.ok) throw new SourceError('soundcloud', `SoundCloud request failed (${response.status}).`)
  return response.json()
}

async function clientOrThrow(fetchImpl, clientId) {
  const id = await getClientId(fetchImpl, clientId)
  if (!id) {
    throw new SourceError(
      'soundcloud',
      'Could not find a SoundCloud client id. Set SOUNDCLOUD_CLIENT_ID and try again.',
    )
  }
  return { id, refresh: !lockedClientId(clientId) }
}

export async function resolveSoundCloud(pageUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const client = await clientOrThrow(fetchImpl, options.clientId)
  const endpoint = new URL('https://api-v2.soundcloud.com/resolve')
  endpoint.searchParams.set('url', pageUrl)
  endpoint.searchParams.set('client_id', client.id)
  const payload = await fetchJson(fetchImpl, endpoint, { refresh: client.refresh })
  const tracks = planSoundCloudTracks(payload, pageUrl, options.maxTracks ?? 10)
  if (tracks.length === 0) {
    throw new SourceError('soundcloud', 'No SoundCloud track found at that URL.')
  }
  return tracks
}

export async function searchSoundCloud(query, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const client = await clientOrThrow(fetchImpl, options.clientId)
  const limit = Math.min(Math.max(1, options.limit ?? 10), 10)
  const endpoint = new URL('https://api-v2.soundcloud.com/search/tracks')
  endpoint.searchParams.set('q', String(query).slice(0, 200))
  endpoint.searchParams.set('client_id', client.id)
  endpoint.searchParams.set('limit', String(limit))
  const payload = await fetchJson(fetchImpl, endpoint, { refresh: client.refresh })
  const list = Array.isArray(payload?.collection) ? payload.collection : []
  return list.map((track) => mapTrack(track)).filter(Boolean).slice(0, limit)
}

export async function relatedSoundCloud(trackId, options = {}) {
  if (!/^\d{1,20}$/.test(String(trackId ?? ''))) return []
  const fetchImpl = options.fetchImpl ?? fetch
  const client = await clientOrThrow(fetchImpl, options.clientId)
  const endpoint = new URL(`https://api-v2.soundcloud.com/tracks/${trackId}/related`)
  endpoint.searchParams.set('client_id', client.id)
  endpoint.searchParams.set('limit', '10')
  const payload = await fetchJson(fetchImpl, endpoint, { refresh: client.refresh })
  const list = Array.isArray(payload?.collection) ? payload.collection : Array.isArray(payload) ? payload : []
  return list.map((track) => mapTrack(track)).filter(Boolean).slice(0, 10)
}

export async function resolveSoundCloudStream(trackUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const client = await clientOrThrow(fetchImpl, options.clientId)
  const endpoint = new URL('https://api-v2.soundcloud.com/resolve')
  endpoint.searchParams.set('url', trackUrl)
  endpoint.searchParams.set('client_id', client.id)
  const payload = await fetchJson(fetchImpl, endpoint, { refresh: client.refresh })
  const track = tracksFromResolve(payload)[0]
  const transcoding = pickTranscoding(track)
  if (!transcoding) {
    throw new SourceError('soundcloud', 'SoundCloud did not return a stream for that track.')
  }
  const streamEndpoint = new URL(transcoding.url)
  streamEndpoint.searchParams.set('client_id', client.id)
  const body = await fetchJson(fetchImpl, streamEndpoint, { refresh: client.refresh })
  if (!body?.url || typeof body.url !== 'string') {
    throw new SourceError('soundcloud', 'SoundCloud stream URL was empty.')
  }
  assertPublicHttpUrl(body.url)
  return body.url
}
