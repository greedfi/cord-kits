import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  discoverClientId,
  extractClientId,
  extractScriptUrls,
  pickTranscoding,
  planSoundCloudTracks,
  resolveSoundCloud,
  resolveSoundCloudStream,
  tracksFromResolve,
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
