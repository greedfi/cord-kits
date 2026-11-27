import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearClientIdCache,
  discoverClientId,
  extractClientId,
  extractScriptUrls,
  getClientId,
  pickTranscoding,
  planSoundCloudTracks,
  relatedSoundCloud,
  resolveSoundCloud,
  resolveSoundCloudStream,
  searchSoundCloud,
  tracksFromResolve,
} from '../src/soundcloud.js'
import { MAX_SCRIPT_URLS } from '../src/limits.js'

const clientId = 'a'.repeat(32)

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

describe('SoundCloud parsing', () => {
  afterEach(() => {
    clearClientIdCache()
    delete process.env.SOUNDCLOUD_CLIENT_ID
  })

  test('extracts script URLs and a client id', () => {
    const html = '<script src="https://a-v2.sndcdn.com/assets/app.js"></script><script src="https://example.com/nope.js"></script>'
    assert.deepEqual(extractScriptUrls(html), ['https://a-v2.sndcdn.com/assets/app.js'])
    assert.equal(extractClientId('client_id:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'), clientId)
    assert.equal(extractClientId('no id here'), null)
  })

  test('plans a track and a playlist, preferring progressive streams', () => {
    const track = {
      kind: 'track',
      title: 'Song',
      permalink_url: 'https://soundcloud.com/artist/song',
      media: {
        transcodings: [
          { url: 'https://api-v2.soundcloud.com/hls', format: { protocol: 'hls' } },
          { url: 'https://api-v2.soundcloud.com/prog', format: { protocol: 'progressive' } },
        ],
      },
    }
    assert.equal(tracksFromResolve(track).length, 1)
    assert.equal(pickTranscoding(track).format.protocol, 'progressive')
    assert.equal(pickTranscoding({ media: { transcodings: [track.media.transcodings[0]] } }).format.protocol, 'hls')
    const playlist = planSoundCloudTracks({
      kind: 'playlist',
      tracks: [
        { title: 'One', permalink_url: 'https://soundcloud.com/a/one' },
        { title: 'Two', permalink_url: 'https://soundcloud.com/a/two' },
        { title: 'Three', permalink_url: 'https://soundcloud.com/a/three' },
      ],
    }, 'https://soundcloud.com/a/sets/demo', 2)
    assert.deepEqual(playlist.map((item) => item.title), ['One', 'Two'])
    assert.equal(playlist[0].kind, 'soundcloud')
  })

  test('resolve uses the client id and returns a public stream URL', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      const href = String(url)
      calls.push(href)
      if (href.includes('/resolve')) {
        return jsonResponse({
          kind: 'track',
          title: 'Song',
          permalink_url: 'https://soundcloud.com/artist/song',
          media: {
            transcodings: [{
              url: 'https://api-v2.soundcloud.com/media/stream',
              format: { protocol: 'progressive', mime_type: 'audio/mpeg' },
            }],
          },
        })
      }
      return jsonResponse({ url: 'https://cf-media.sndcdn.com/stream.mp3' })
    }
    const tracks = await resolveSoundCloud('https://soundcloud.com/artist/song', {
      fetchImpl,
      clientId,
      maxTracks: 5,
    })
    assert.equal(tracks[0].title, 'Song')
    assert.equal(tracks[0].url, 'https://soundcloud.com/artist/song')
    assert.ok(calls[0].includes(`client_id=${clientId}`))
    const stream = await resolveSoundCloudStream(tracks[0].url, { fetchImpl, clientId })
    assert.equal(stream, 'https://cf-media.sndcdn.com/stream.mp3')
  })

  test('discoverClientId reads the id out of a script', async () => {
    const fetchImpl = async (url) => {
      if (String(url) === 'https://soundcloud.com/') {
        return jsonResponse('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>')
      }
      return jsonResponse(`client_id:"${clientId}"`)
    }
    assert.equal(await discoverClientId(fetchImpl), clientId)
  })

  test('finds a client id past the eighth script and stops at the cap', async () => {
    const scripts = Array.from({ length: 12 }, (_item, index) => `https://a-v2.sndcdn.com/app-${index}.js`)
    const seen = []
    const fetchImpl = async (url) => {
      const href = String(url)
      seen.push(href)
      if (href === 'https://soundcloud.com/') {
        return jsonResponse(scripts.map((script) => `<script src="${script}"></script>`).join(''))
      }
      if (href.endsWith('app-9.js')) return jsonResponse(`client_id:"${clientId}"`)
      return jsonResponse('no id')
    }
    assert.equal(extractScriptUrls(scripts.map((script) => `<script src="${script}"></script>`).join('')).length, 12)
    assert.equal(await discoverClientId(fetchImpl), clientId)
    assert.equal(seen.filter((href) => href.includes('app-')).length, 10)
    assert.equal(seen.some((href) => href.endsWith('app-7.js')), true)
    assert.equal(seen.some((href) => href.endsWith('app-11.js')), false)

    const many = Array.from({ length: 40 }, (_item, index) => `https://a-v2.sndcdn.com/cap-${index}.js`)
    let fetched = 0
    const capped = async (url) => {
      const href = String(url)
      if (href === 'https://soundcloud.com/') {
        return jsonResponse(many.map((script) => `<script src="${script}"></script>`).join(''))
      }
      fetched += 1
      if (href.endsWith('cap-35.js')) return jsonResponse(`client_id:"${clientId}"`)
      return jsonResponse('no id')
    }
    assert.equal(await discoverClientId(capped, { limit: MAX_SCRIPT_URLS }), null)
    assert.equal(fetched, MAX_SCRIPT_URLS)
  })

  test('skips a script over the byte cap and still finds a later id', async () => {
    let read = false
    const fetchImpl = async (url) => {
      const href = String(url)
      if (href === 'https://soundcloud.com/') {
        return jsonResponse('<script src="https://a-v2.sndcdn.com/big.js"></script><script src="https://a-v2.sndcdn.com/small.js"></script>')
      }
      if (href.endsWith('big.js')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => '9000000' },
          async text() {
            read = true
            return ''
          },
        }
      }
      return jsonResponse(`client_id:"${clientId}"`)
    }
    assert.equal(await discoverClientId(fetchImpl, { maxBytes: 1000 }), clientId)
    assert.equal(read, false)
  })

  test('caches the discovered id and refreshes it after 401', async () => {
    const first = 'a'.repeat(32)
    const second = 'b'.repeat(32)
    let homes = 0
    const fetchImpl = async (url) => {
      const href = String(url)
      if (href === 'https://soundcloud.com/') {
        homes += 1
        const id = homes === 1 ? first : second
        return jsonResponse(`<script src="https://a-v2.sndcdn.com/${id.slice(0, 6)}.js"></script>`)
      }
      if (href.includes('sndcdn.com')) {
        const id = href.includes(first.slice(0, 6)) ? first : second
        return jsonResponse(`client_id:"${id}"`)
      }
      if (href.includes(`client_id=${first}`)) return jsonResponse({ message: 'no' }, 401)
      if (href.includes('/resolve')) {
        return jsonResponse({
          kind: 'track',
          title: 'Song',
          permalink_url: 'https://soundcloud.com/artist/song',
        })
      }
      return jsonResponse({})
    }
    assert.equal(await getClientId(fetchImpl), first)
    assert.equal(await getClientId(fetchImpl), first)
    assert.equal(homes, 1)
    const tracks = await resolveSoundCloud('https://soundcloud.com/artist/song', { fetchImpl })
    assert.equal(tracks[0].title, 'Song')
    assert.equal(homes, 2)
    assert.equal(await getClientId(fetchImpl), second)
  })

  test('SOUNDCLOUD_CLIENT_ID is not replaced when SoundCloud returns 401', async () => {
    process.env.SOUNDCLOUD_CLIENT_ID = 'c'.repeat(32)
    let homes = 0
    const fetchImpl = async (url) => {
      if (String(url) === 'https://soundcloud.com/') homes += 1
      return jsonResponse({ message: 'no' }, 403)
    }
    await assert.rejects(
      () => resolveSoundCloud('https://soundcloud.com/artist/song', { fetchImpl }),
      /403/,
    )
    assert.equal(homes, 0)
  })

  test('search maps public tracks and related refuses a non-numeric id', async () => {
    const fetchImpl = async (url) => {
      assert.equal(String(url).includes('search/tracks'), true)
      return jsonResponse({
        collection: [{
          id: 42,
          title: 'Found',
          permalink_url: 'https://soundcloud.com/artist/found',
          duration: 1200,
          artwork_url: 'https://i1.sndcdn.com/art.jpg',
        }],
      })
    }
    const found = await searchSoundCloud('found', { fetchImpl, clientId })
    assert.equal(found[0].soundcloudId, '42')
    assert.equal(found[0].artworkUrl, 'https://i1.sndcdn.com/art.jpg')
    let called = false
    assert.deepEqual(await relatedSoundCloud('../etc', {
      fetchImpl: async () => {
        called = true
        return jsonResponse({})
      },
    }), [])
    assert.equal(called, false)
  })

  test('rejects a YouTube URL returned as a stream', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/resolve')) {
        return jsonResponse({
          kind: 'track',
          title: 'Nope',
          permalink_url: 'https://soundcloud.com/a/b',
          media: { transcodings: [{ url: 'https://api-v2.soundcloud.com/media/x', format: { protocol: 'progressive' } }] },
        })
      }
      return jsonResponse({ url: 'https://www.youtube.com/watch?v=abc' })
    }
    await assert.rejects(
      () => resolveSoundCloudStream('https://soundcloud.com/a/b', { fetchImpl, clientId }),
      (error) => error.code === 'youtube',
    )
  })
})
