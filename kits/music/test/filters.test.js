import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ffmpegArguments, filterGraph } from '../src/filters.js'

describe('ffmpeg filters', () => {
  test('presets are a fixed argument list and titles cannot change the command', () => {
    assert.equal(filterGraph('nope'), null)
    const args = ffmpegArguments('https://cdn.example.com/song.mp3', {
      seekSeconds: 12.5,
      filter: 'bassboost',
    })
    assert.equal(args.includes('-af'), true)
    assert.equal(args.at(-1), 'pipe:1')
    assert.equal(args.includes('https://cdn.example.com/song.mp3'), true)
    assert.equal(args.includes('; rm -rf /'), false)
    const nightcore = ffmpegArguments('https://cdn.example.com/a.mp3', { filter: 'nightcore' })
    assert.equal(nightcore.includes('asetrate=48000*1.25,aresample=48000'), true)
    const around = ffmpegArguments('https://cdn.example.com/a.mp3', { filter: '8d' })
    assert.equal(around.includes('apulsator=hz=0.08'), true)
    const plain = ffmpegArguments('https://cdn.example.com/a.mp3', { filter: 'off', seekSeconds: 0 })
    assert.equal(plain.includes('-af'), false)
    assert.equal(plain.includes('-ss'), false)
    assert.throws(() => ffmpegArguments('https://cdn.example.com/a.mp3', { seekSeconds: Number.NaN }))
  })
})
