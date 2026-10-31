import { SourceError, assertPublicHttpUrl } from './sources.js'

const USER_AGENT = 'cord-kits-music/0.1'
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
    .filter((track) => track.title || track.permalink_url)
    .slice(0, maxTracks)
    .map((track) => ({
      kind: 'soundcloud',
      title: track.title || 'SoundCloud track',
      url: track.permalink_url || pageUrl,
    }))
}

export async function discoverClientId(fetchImpl = fetch) {
  const home = await fetchImpl('https://soundcloud.com/', {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!home.ok) return null
  const html = await home.text()
  for (const scriptUrl of extractScriptUrls(html).slice(0, 8)) {
    const response = await fetchImpl(scriptUrl, { headers: { 'User-Agent': USER_AGENT } })
    if (!response.ok) continue
    const clientId = extractClientId(await response.text())
    if (clientId) return clientId
  }
  return null
}

export async function getClientId(fetchImpl = fetch, override) {
  if (override) return override
  const fromEnv = process.env.SOUNDCLOUD_CLIENT_ID?.trim()
  if (fromEnv) return fromEnv
  if (cachedClientId) return cachedClientId
  const discovered = await discoverClientId(fetchImpl)
  if (discovered) cachedClientId = discovered
  return discovered
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new SourceError('soundcloud', `SoundCloud request failed (${response.status}).`)
  }
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
  return id
}

export async function resolveSoundCloud(pageUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const clientId = await clientOrThrow(fetchImpl, options.clientId)
  const endpoint = new URL('https://api-v2.soundcloud.com/resolve')
  endpoint.searchParams.set('url', pageUrl)
  endpoint.searchParams.set('client_id', clientId)
  const payload = await fetchJson(fetchImpl, endpoint)
  const tracks = planSoundCloudTracks(payload, pageUrl, options.maxTracks ?? 10)
  if (tracks.length === 0) {
    throw new SourceError('soundcloud', 'No SoundCloud track found at that URL.')
  }
  return tracks
}

export async function resolveSoundCloudStream(trackUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const clientId = await clientOrThrow(fetchImpl, options.clientId)
  const endpoint = new URL('https://api-v2.soundcloud.com/resolve')
  endpoint.searchParams.set('url', trackUrl)
  endpoint.searchParams.set('client_id', clientId)
  const payload = await fetchJson(fetchImpl, endpoint)
  const track = tracksFromResolve(payload)[0]
  const transcoding = pickTranscoding(track)
  if (!transcoding) {
    throw new SourceError('soundcloud', 'SoundCloud did not return a stream for that track.')
  }
  const streamEndpoint = new URL(transcoding.url)
  streamEndpoint.searchParams.set('client_id', clientId)
  const body = await fetchJson(fetchImpl, streamEndpoint)
  if (!body?.url || typeof body.url !== 'string') {
    throw new SourceError('soundcloud', 'SoundCloud stream URL was empty.')
  }
  assertPublicHttpUrl(body.url)
  return body.url
}
