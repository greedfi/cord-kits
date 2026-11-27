import { searchSoundCloud, resolveSoundCloud } from './soundcloud.js'
import { SourceError, classifySource } from './sources.js'

export async function resolveTracks(input, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const clientId = options.clientId
  const mode = options.mode ?? 'play'
  const limit = options.limit ?? 10
  if (input.attachment) return [classifySource(null, { attachment: input.attachment, kind: input.kind })]
  const classified = classifySource(input.query, { kind: input.kind })
  if (classified.kind === 'search') {
    const found = await searchSoundCloud(classified.query, {
      fetchImpl,
      clientId,
      limit: mode === 'one' ? 1 : Math.min(limit, 10),
    })
    if (found.length === 0) {
      throw new SourceError('not_found', 'No SoundCloud results for that search.')
    }
    return mode === 'one' ? found.slice(0, 1) : found
  }
  if (classified.kind === 'soundcloud') {
    const tracks = await resolveSoundCloud(classified.url, {
      fetchImpl,
      clientId,
      maxTracks: limit,
    })
    return mode === 'one' ? tracks.slice(0, 1) : tracks
  }
  return [classified]
}
