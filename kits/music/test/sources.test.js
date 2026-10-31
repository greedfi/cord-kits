import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SourceError, classifySource, isYouTubeUrl } from '../src/sources.js'

const youtubeUrls = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtube.com/watch?v=abc',
  'https://m.youtube.com/watch?v=abc',
  'https://music.youtube.com/watch?v=abc',
  'https://youtu.be/dQw4w9WgXcQ',
  'https://www.youtube.com/shorts/abc',
  'https://www.youtube-nocookie.com/embed/abc',
  'http://youtu.be/abc?list=xyz',
  'https://consent.youtube.com/m?continue=https://www.youtube.com/',
  'https://www.youtube.com/watch?v=abc&file=song.mp3',
]

describe('source resolution', () => {
  test('rejects YouTube URLs', () => {
    for (const url of youtubeUrls) {
      assert.equal(isYouTubeUrl(url), true, url)
      assert.throws(() => classifySource(url), (error) => {
        assert.equal(error.code, 'youtube')
        assert.match(error.message, /YouTube/)
        return true
      })
      assert.throws(
        () => classifySource(url, { kind: 'direct' }),
        (error) => error instanceof SourceError && error.code === 'youtube',
      )
    }
  })

  test('rejects a YouTube attachment URL', () => {
    assert.throws(() => classifySource(null, {
      attachment: {
        url: 'https://www.youtube.com/watch?v=abc',
        name: 'song.mp3',
        contentType: 'audio/mpeg',
      },
    }), (error) => error.code === 'youtube')
  })

  test('accepts SoundCloud, direct audio, radio, and attachments', () => {
    const soundcloud = classifySource('https://soundcloud.com/artist/track')
    assert.equal(soundcloud.kind, 'soundcloud')
    assert.equal(classifySource('https://on.soundcloud.com/abc123').kind, 'soundcloud')
    assert.equal(classifySource('https://m.soundcloud.com/artist/track').kind, 'soundcloud')

    const direct = classifySource('https://cdn.example.com/a/b/track.flac?download=1')
    assert.equal(direct.kind, 'direct')
    assert.equal(direct.title, 'track')

    assert.equal(classifySource('https://radio.example.com/live.m3u8').kind, 'radio')
    assert.equal(classifySource('https://radio.example.com/stream.pls').kind, 'radio')
    assert.equal(classifySource('https://ice.example.com/station/stream').kind, 'radio')
    assert.equal(classifySource('https://example.com:8000/listen', { kind: 'radio' }).kind, 'radio')

    const attachment = classifySource(null, {
      attachment: {
        url: 'https://cdn.discordapp.com/attachments/1/2/voice.mp3',
        name: 'voice.mp3',
        contentType: 'audio/mpeg',
        size: 1024,
      },
    })
    assert.equal(attachment.kind, 'attachment')
    assert.equal(attachment.title, 'voice')

    const typed = classifySource(null, {
      attachment: {
        url: 'https://cdn.discordapp.com/attachments/1/2/blob',
        name: 'blob',
        contentType: 'audio/ogg',
        size: 100,
      },
    })
    assert.equal(typed.kind, 'attachment')
  })

  test('rejects unsupported pages, non-audio files, private hosts, and empty input', () => {
    assert.throws(() => classifySource('https://example.com/page'), (error) => error.code === 'unsupported')
    assert.throws(() => classifySource(null, {
      attachment: {
        url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        name: 'photo.png',
        contentType: 'image/png',
        size: 100,
      },
    }), (error) => error.code === 'unsupported')
    assert.throws(() => classifySource(null, {
      attachment: {
        url: 'https://cdn.discordapp.com/attachments/1/2/big.mp3',
        name: 'big.mp3',
        contentType: 'audio/mpeg',
        size: 26 * 1024 * 1024,
      },
    }), (error) => error.code === 'unsupported')
    for (const url of [
      'http://127.0.0.1/a.mp3',
      'http://localhost/a.mp3',
      'http://10.1.2.3/a.mp3',
      'http://192.168.1.5/a.mp3',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a.mp3',
      'http://2130706433/a.mp3',
      'file:///etc/passwd',
      'https://user:pass@example.com/a.mp3',
    ]) {
      assert.throws(() => classifySource(url), SourceError, url)
    }
    assert.throws(() => classifySource('   '), (error) => error.code === 'empty')
    assert.throws(
      () => classifySource('https://example.com/song.mp3', { kind: 'soundcloud' }),
      (error) => error.code === 'unsupported',
    )
  })

  test('a file named youtube.mp3 on another host is direct audio', () => {
    const source = classifySource('https://cdn.example.com/youtube.mp3')
    assert.equal(source.kind, 'direct')
  })
})
