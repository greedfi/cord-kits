import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGuildQueues,
  createQueueState,
  enqueue,
  enqueueMany,
  formatQueue,
  promote,
  safeLabel,
  setVolume,
  skip,
  stop,
} from '../src/queue.js'

const track = (url, title = url) => ({ kind: 'direct', url, title })

describe('queue', () => {
  test('enqueue, promote, skip, and stop are immutable', () => {
    const initial = createQueueState(40)
    const first = enqueue(initial, track('https://example.com/a.mp3', 'A'), 2)
    const second = enqueue(first.state, track('https://example.com/b.mp3', 'B'), 2)
    assert.equal(initial.tracks.length, 0)
    assert.equal(second.ok, true)
    const started = promote(second.state)
    assert.equal(started.track.title, 'A')
    assert.equal(started.state.current.title, 'A')
    assert.deepEqual(started.state.tracks.map((item) => item.title), ['B'])
    assert.equal(second.state.tracks.length, 2)

    const skipped = skip(started.state)
    assert.equal(skipped.track.title, 'B')
    assert.equal(skipped.state.tracks.length, 0)

    const ended = skip(skipped.state)
    assert.equal(ended.track, null)
    assert.equal(ended.state.current, null)

    const playing = promote(second.state)
    const stopped = stop(playing.state)
    assert.equal(stopped.current, null)
    assert.deepEqual(stopped.tracks, [])
    assert.equal(playing.state.current.title, 'A')
  })

  test('rejects a full waiting list and keeps the previous state', () => {
    let state = createQueueState()
    state = enqueue(state, track('a'), 1).state
    const blocked = enqueue(state, track('b'), 1)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'queue_full')
    assert.equal(state.tracks.length, 1)
    assert.equal(blocked.state, state)
  })

  test('enqueueMany accepts a partial playlist', () => {
    const state = { current: track('now'), tracks: [track('a')], volume: 10 }
    const result = enqueueMany(state, [track('b'), track('c'), track('d')], 2)
    assert.equal(result.ok, true)
    assert.equal(result.accepted.length, 1)
    assert.equal(result.rejected, 2)
    assert.equal(result.state.tracks.length, 2)
    assert.equal(state.tracks.length, 1)
  })

  test('volume is an integer from 0 to 100', () => {
    assert.equal(setVolume(createQueueState(), 0).volume, 0)
    assert.equal(setVolume(createQueueState(), 100).volume, 100)
    for (const value of [-1, 101, 1.5, Number.NaN]) {
      assert.throws(() => setVolume(createQueueState(), value), RangeError)
    }
  })

  test('guild queues do not share tracks', () => {
    const queues = createGuildQueues(30)
    queues.set('111111111111111111', enqueue(queues.get('111111111111111111'), track('a'), 5).state)
    assert.equal(queues.get('222222222222222222').tracks.length, 0)
    assert.equal(queues.get('222222222222222222').volume, 30)
    assert.equal(queues.get('111111111111111111').tracks.length, 1)
  })

  test('formatQueue lists the current track and caps the waiting list', () => {
    const state = {
      current: { title: 'Now *playing*', url: 'https://example.com/now.mp3' },
      tracks: Array.from({ length: 12 }, (_item, index) => ({
        title: `Track ${index + 1}`,
        url: `https://example.com/${index}.mp3`,
        requestedByTag: 'alice',
      })),
      volume: 40,
    }
    const text = formatQueue(state, { limit: 10 })
    assert.match(text, /Now playing: Now playing/)
    assert.match(text, /Volume: 40%/)
    assert.match(text, /10\. Track 10 — alice/)
    assert.match(text, /…and 2 more/)
    assert.equal(safeLabel('***hello***').includes('*'), false)
  })
})
