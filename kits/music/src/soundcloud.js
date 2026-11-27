import { SourceError, assertPublicHttpUrl } from './sources.js'

const USER_AGENT = 'cord-kits-music/0.1'
export const MAX_DISCOVERY_SCRIPTS = 30
export const MAX_HTML_CHARS = 1_500_000
export const MAX_SCRIPT_CHARS = 2_000_000

let cachedClientId = null

export function clearClientIdCache() {
  cachedClientId = null
}

export function extractScriptUrls(html) {
  const urls = new Set()
  const pattern = /https:\/\/[^"'\\\s>]+\.js/g
  for (const match of String(html).matchAll(pattern)) {
    const url = match[0]
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

export function tracksFromResolve(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (payload.kind === 'track' || Array.isArray(payload.media?.transcodings)) return [payload]
  if (Array.isArray(payload.tracks)) {
    return payload.tracks.filter((track) => track && typeof track === 'object')
  }
  if (Array.isArray(payload.collection)) {
    return payload.collection.filter((track) => track && typeof track === 'object')
  }
  return []
}

export function mapTrack(raw, pageUrl) {
  const url = raw.permalink_url || pageUrl
  if (!url) return null
  return {
    kind: 'soundcloud',
    title: raw.title || 'SoundCloud track',
    url,
    durationMs: Number.isFinite(raw.duration) ? raw.duration : null,
    soundcloudId: raw.id == null ? null : String(raw.id),
    artist: raw.user?.username ?? null,
  }
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
    .filter((track) => track && (track.title || track.url))
    .slice(0, maxTracks)
}

export async function discoverClientId(fetchImpl = fetch, options = {}) {
  const maxScripts = options.maxScripts ?? MAX_DISCOVERY_SCRIPTS
  const home = await fetchImpl('https://soundcloud.com/', {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!home.ok) return null
  const html = (await home.text()).slice(0, MAX_HTML_CHARS)
  const scripts = extractScriptUrls(html).slice(0, maxScripts)
  for (const scriptUrl of scripts) {
    const response = await fetchImpl(scriptUrl, { headers: { 'User-Agent': USER_AGENT } })
    if (!response.ok) continue
    const clientId = extractClientId((await response.text()).slice(0, MAX_SCRIPT_CHARS))
    if (clientId) return clientId
  }
  return null
}

function envClientId() {
  const value = process.env.SOUNDCLOUD_CLIENT_ID?.trim()
  return value || null
}

export async function getClientId(fetchImpl = fetch, override) {
  if (override) return override
  const fromEnv = envClientId()
  if (fromEnv) return fromEnv
  if (cachedClientId) return cachedClientId
  const discovered = await discoverClientId(fetchImpl)
  if (discovered) cachedClientId = discovered
  return discovered
}

class SoundCloudHttpError extends Error {
  constructor(status) {
    super(`SoundCloud request failed (${status}).`)
    this.name = 'SoundCloudHttpError'
    this.status = status
  }
}

async function requestJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (!response.ok) throw new SoundCloudHttpError(response.status)
  return response.json()
}

async function withClient(fetchImpl, override, run) {
  const pinned = Boolean(override || envClientId())
  const clientId = await getClientId(fetchImpl, override)
  if (!clientId) {
    throw new SourceError(
      'soundcloud',
      'Could not find a SoundCloud client id. Set SOUNDCLOUD_CLIENT_ID and try again.',
    )
  }
  try {
    return await run(clientId)
  } catch (error) {
    const status = error?.status
    if (pinned || (status !== 401 && status !== 403)) throw error
    const rejected = clientId
    clearClientIdCache()
    const refreshed = await discoverClientId(fetchImpl)
    if (!refreshed || refreshed === rejected) throw error
    cachedClientId = refreshed
    return run(refreshed)
  }
}

function resolveEndpoint(pageUrl, clientId) {
  const endpoint = new URL('https://api-v2.soundcloud.com/resolve')
  endpoint.searchParams.set('url', pageUrl)
  endpoint.searchParams.set('client_id', clientId)
  return endpoint
}

export async function resolveSoundCloud(pageUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const payload = await withClient(fetchImpl, options.clientId, (clientId) => (
    requestJson(fetchImpl, resolveEndpoint(pageUrl, clientId))
  ))
  const tracks = planSoundCloudTracks(payload, pageUrl, options.maxTracks ?? 10)
  if (tracks.length === 0) {
    throw new SourceError('soundcloud', 'No SoundCloud track found at that URL.')
  }
  return tracks
}

export async function searchSoundCloud(query, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const limit = Math.min(options.limit ?? 10, 10)
  const text = String(query ?? '').trim().slice(0, 200)
  if (!text) return []
  const payload = await withClient(fetchImpl, options.clientId, (clientId) => {
    const endpoint = new URL('https://api-v2.soundcloud.com/search/tracks')
    endpoint.searchParams.set('q', text)
    endpoint.searchParams.set('client_id', clientId)
    endpoint.searchParams.set('limit', String(limit))
    return requestJson(fetchImpl, endpoint)
  })
  return planSoundCloudTracks(payload, null, limit).filter((track) => {
    try {
      assertPublicHttpUrl(track.url)
      return true
    } catch {
      return false
    }
  })
}

export async function relatedSoundCloudTracks(track, options = {}) {
  const id = track?.soundcloudId
  if (!/^\d+$/.test(String(id ?? ''))) return []
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const payload = await withClient(fetchImpl, options.clientId, (clientId) => {
      const endpoint = new URL(`https://api-v2.soundcloud.com/tracks/${id}/related`)
      endpoint.searchParams.set('client_id', clientId)
      endpoint.searchParams.set('limit', '10')
      return requestJson(fetchImpl, endpoint)
    })
    return planSoundCloudTracks(payload, null, 10).filter((item) => {
      try {
        assertPublicHttpUrl(item.url)
        return true
      } catch {
        return false
      }
    })
  } catch (error) {
    if (error instanceof SourceError) throw error
    return []
  }
}

export function chooseAutoplayTrack(candidates, { current, queued = [], recent = [] } = {}) {
  const seen = new Set(
    [current?.url, ...queued.map((track) => track.url), ...recent.map((track) => track.url)]
      .filter(Boolean),
  )
  const artists = new Map()
  for (const track of [current, ...recent].filter(Boolean)) {
    if (!track.artist) continue
    artists.set(track.artist, (artists.get(track.artist) ?? 0) + 1)
  }
  for (const candidate of candidates) {
    if (!candidate?.url || seen.has(candidate.url)) continue
    if (current?.soundcloudId && candidate.soundcloudId === current.soundcloudId) continue
    if (candidate.artist && (artists.get(candidate.artist) ?? 0) >= 3) continue
    return candidate
  }
  return null
}

export async function resolveSoundCloudStream(trackUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const payload = await withClient(fetchImpl, options.clientId, (clientId) => (
    requestJson(fetchImpl, resolveEndpoint(trackUrl, clientId))
  ))
  const track = tracksFromResolve(payload)[0]
  const transcoding = pickTranscoding(track)
  if (!transcoding) {
    throw new SourceError('soundcloud', 'SoundCloud did not return a stream for that track.')
  }
  const streamUrl = await withClient(fetchImpl, options.clientId, async (clientId) => {
    const streamEndpoint = new URL(transcoding.url)
    streamEndpoint.searchParams.set('client_id', clientId)
    const body = await requestJson(fetchImpl, streamEndpoint)
    if (!body?.url || typeof body.url !== 'string') {
      throw new SourceError('soundcloud', 'SoundCloud stream URL was empty.')
    }
    return body.url
  })
  assertPublicHttpUrl(streamUrl)
  return streamUrl
}
