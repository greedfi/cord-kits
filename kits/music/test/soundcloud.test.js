import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseAutoplayTrack,
  clearClientIdCache,
  discoverClientId,
  extractClientId,
  extractScriptUrls,
  pickTranscoding,
  planSoundCloudTracks,
  resolveSoundCloud,
  tracksFromResolve,
  resolveSoundCloudStream,
  searchSoundCloud,
} from '../src/soundcloud.js'

const clientId = 'a'.repeat(32)

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

describe('SoundCloud parsing', () => {
  test('extracts script URLs and a client id', () => {
    const html = '<script src="https://a-v2.sndcdn.com/assets/app.js"></script><script src="https://example.com/nope.js"></script>'
    assert.deepEqual(extractScriptUrls(html), ['https://a-v2.sndcdn.com/assets/app.js'])
    const queried = '<script src="https://a-v2.sndcdn.com/assets/app.js?v=10&x=1"></script>'
    assert.deepEqual(extractScriptUrls(queried), ['https://a-v2.sndcdn.com/assets/app.js?v=10&x=1'])
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
    const urls = Array.from({ length: 12 }, (_item, index) => `https://a-v2.sndcdn.com/assets/${index}.js`)
    const html = urls.map((url) => `<script src="${url}"></script>`).join('')
    const seen = []
    const fetchImpl = async (url) => {
      const href = String(url)
      seen.push(href)
      if (href === 'https://soundcloud.com/') return jsonResponse(html)
      if (urls.indexOf(href) === 9) return jsonResponse(`client_id:"${clientId}"`)
      return jsonResponse('no id here')
    }
    assert.equal(await discoverClientId(fetchImpl), clientId)
    assert.ok(seen.includes(urls[9]))
    assert.equal(seen.includes(urls[0]), true)
    const capped = []
    const cappedFetch = async (url) => {
      const href = String(url)
      capped.push(href)
      if (href === 'https://soundcloud.com/') return jsonResponse(html)
      return jsonResponse('no id here')
    }
    assert.equal(await discoverClientId(cappedFetch, { maxScripts: 8 }), null)
    assert.equal(capped.filter((href) => href.endsWith('.js')).length, 8)
    assert.equal(capped.includes(urls[9]), false)
  })

  test('a 401 drops the cached id, discovers a replacement once, and leaves an override alone', async () => {
    clearClientIdCache()
    const previous = process.env.SOUNDCLOUD_CLIENT_ID
    delete process.env.SOUNDCLOUD_CLIENT_ID
    const first = 'a'.repeat(32)
    const second = 'b'.repeat(32)
    let homes = 0
    let resolves = 0
    const fetchImpl = async (url) => {
      const href = String(url)
      if (href === 'https://soundcloud.com/') {
        homes += 1
        return jsonResponse('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>')
      }
      if (href.endsWith('/app.js')) return jsonResponse(`client_id:"${homes === 1 ? first : second}"`)
      if (href.includes('/resolve')) {
        resolves += 1
        if (href.includes(`client_id=${first}`)) return jsonResponse({ message: 'no' }, 401)
        return jsonResponse({
          kind: 'track',
          title: 'Song',
          permalink_url: 'https://soundcloud.com/artist/song',
          id: 7,
        })
      }
      throw new Error(`unexpected ${href}`)
    }
    try {
      const tracks = await resolveSoundCloud('https://soundcloud.com/artist/song', { fetchImpl })
      assert.equal(tracks[0].title, 'Song')
      assert.equal(homes, 2)
      assert.equal(resolves, 2)
      homes = 0
      const cached = await resolveSoundCloud('https://soundcloud.com/artist/song', { fetchImpl })
      assert.equal(cached[0].soundcloudId, '7')
      assert.equal(homes, 0)

      let overrideHomes = 0
      await assert.rejects(
        () => resolveSoundCloud('https://soundcloud.com/artist/song', {
          clientId: first,
          fetchImpl: async (url) => {
            if (String(url) === 'https://soundcloud.com/') overrideHomes += 1
            return jsonResponse({ message: 'no' }, 401)
          },
        }),
        (error) => error.status === 401,
      )
      assert.equal(overrideHomes, 0)

      clearClientIdCache()
      let loops = 0
      await assert.rejects(
        () => resolveSoundCloud('https://soundcloud.com/artist/song', {
          fetchImpl: async (url) => {
            const href = String(url)
            if (href === 'https://soundcloud.com/') {
              loops += 1
              return jsonResponse('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>')
            }
            if (href.endsWith('/app.js')) return jsonResponse(`client_id:"${loops === 1 ? first : second}"`)
            return jsonResponse({ message: 'no' }, 403)
          },
        }),
        (error) => error.status === 403,
      )
      assert.equal(loops, 2)
    } finally {
      if (previous === undefined) delete process.env.SOUNDCLOUD_CLIENT_ID
      else process.env.SOUNDCLOUD_CLIENT_ID = previous
      clearClientIdCache()
    }
  })

  test('search maps public tracks and autoplay skips repeats and a repeated artist', async () => {
    const fetchImpl = async (url) => {
      assert.match(String(url), /search\/tracks/)
      assert.match(String(url), /client_id=/)
      return jsonResponse({
        collection: [
          { id: 1, title: 'Kept', permalink_url: 'https://soundcloud.com/a/kept', user: { username: 'Ada' }, duration: 1000 },
          { id: 2, title: 'Secret', permalink_url: 'http://127.0.0.1/nope', user: { username: 'Ada' } },
        ],
      })
    }
    const found = await searchSoundCloud('kept', { fetchImpl, clientId })
    assert.deepEqual(found.map((track) => track.title), ['Kept'])
    const current = { url: 'https://soundcloud.com/a/now', artist: 'Ada', soundcloudId: '9' }
    const recent = [
      { url: 'https://soundcloud.com/a/old', artist: 'Ada' },
      { url: 'https://soundcloud.com/a/older', artist: 'Ada' },
    ]
    assert.equal(chooseAutoplayTrack([
      current,
      { url: 'https://soundcloud.com/a/same', artist: 'Bea', soundcloudId: '9' },
      { url: 'https://soundcloud.com/a/again', artist: 'Ada' },
    ], { current, queued: [{ url: 'https://soundcloud.com/a/queued' }], recent }), null)
    assert.equal(chooseAutoplayTrack([
      { url: 'https://soundcloud.com/a/fresh', artist: 'Bea' },
    ], { current, queued: [], recent: recent.slice(0, 1) }).url, 'https://soundcloud.com/a/fresh')
  })

  test('shares one in-flight discovery and aborts each fetch', async () => {
    clearClientIdCache()
    let homes = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const fetchImpl = async (url, options) => {
      assert.equal(typeof options.signal.throwIfAborted, 'function')
      if (String(url) === 'https://soundcloud.com/') {
        homes += 1
        await gate
        return jsonResponse('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>')
      }
      return jsonResponse(`client_id:"${clientId}"`)
    }
    const first = discoverClientId(fetchImpl)
    const second = discoverClientId(fetchImpl)
    assert.equal(homes, 1)
    release()
    const [found, again] = await Promise.all([first, second])
    assert.equal(found, clientId)
    assert.equal(again, clientId)
    assert.equal(homes, 1)
    clearClientIdCache()
  })

  test('stops reading a discovery body once it hits the cap', async () => {
    clearClientIdCache()
    const reads = []
    const fetchImpl = async (url) => {
      if (String(url) !== 'https://soundcloud.com/') return jsonResponse('no')
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                reads.push('chunk')
                return { done: false, value: new TextEncoder().encode('x'.repeat(50)) }
              },
              async cancel() {
                reads.push('cancel')
              },
            }
          },
        },
      }
    }
    assert.equal(await discoverClientId(fetchImpl, { maxHtmlChars: 20 }), null)
    assert.equal(reads.includes('cancel'), true)
    assert.ok(reads.filter((item) => item === 'chunk').length < 5)
    clearClientIdCache()
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
