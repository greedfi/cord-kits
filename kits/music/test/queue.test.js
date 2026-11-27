import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  back,
  createQueueState,
  enqueue,
  enqueueMany,
  finishCurrent,
  insertFront,
  formatQueue,
  moveTrack,
  parseClock,
  promote,
  removeAt,
  safeLabel,
  seekTo,
  setVolume,
  shuffleTracks,
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

    const skipped = finishCurrent(started.state, { natural: false })
    assert.equal(skipped.track.title, 'B')
    assert.equal(skipped.state.tracks.length, 0)

    const ended = finishCurrent(skipped.state, { natural: false })
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
    assert.equal(safeLabel('<@123> @everyone'), 'Untitled')
  })

  test('loop, skip, back, move, remove, seek, and shuffle cover the edges', () => {
    const song = { ...createQueueState(), current: track('https://example.com/a.mp3', 'A'), loop: 'song' }
    const replayed = finishCurrent(song, { natural: true })
    assert.equal(replayed.track.title, 'A')
    assert.equal(replayed.state.current.title, 'A')
    const skipped = finishCurrent(song, { natural: false })
    assert.equal(skipped.track, null)
    assert.equal(skipped.state.history[0].title, 'A')

    const queued = {
      ...createQueueState(),
      current: track('https://example.com/a.mp3', 'A'),
      tracks: [track('https://example.com/b.mp3', 'B')],
      loop: 'queue',
    }
    const rotated = finishCurrent(queued, { natural: true })
    assert.equal(rotated.track.title, 'B')
    assert.equal(rotated.state.tracks[0].title, 'A')
    const skippedQueue = finishCurrent(queued, { natural: false })
    assert.equal(skippedQueue.track.title, 'B')
    assert.equal(skippedQueue.state.tracks.length, 0)

    const history = finishCurrent(queued, { natural: false }).state
    const returned = back(history)
    assert.equal(returned.ok, true)
    assert.equal(returned.track.title, 'A')
    assert.equal(returned.state.tracks[0].title, 'B')
    const empty = back(createQueueState())
    assert.equal(empty.ok, false)
    assert.equal(empty.state.history.length, 0)
    const full = {
      ...createQueueState(),
      current: track('now', 'Now'),
      tracks: [track('a', 'A')],
      history: [track('old', 'Old')],
    }
    const blocked = back(full, 1)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'queue_full')
    assert.equal(blocked.state.tracks.length, 1)
    assert.equal(back(full, 2).ok, true)

    const waiting = [track('a', 'A'), track('b', 'B'), track('c', 'C')]
    assert.deepEqual(moveTrack(waiting, 1, 1).tracks.map((item) => item.title), ['A', 'B', 'C'])
    assert.deepEqual(moveTrack(waiting, 1, 3).tracks.map((item) => item.title), ['B', 'C', 'A'])
    assert.equal(moveTrack(waiting, 0, 1).ok, false)
    assert.equal(moveTrack(waiting, 4, 1).ok, false)
    assert.equal(waiting.map((item) => item.title).join(''), 'ABC')
    assert.equal(removeAt(waiting, 2).removed.title, 'B')
    assert.equal(removeAt(waiting, 9).ok, false)

    const playing = {
      ...createQueueState(),
      current: { ...track('https://example.com/a.mp3', 'A'), kind: 'direct', durationMs: 90_000 },
    }
    assert.equal(seekTo(playing, 90_000).error, 'past_end')
    assert.equal(seekTo(playing, -1).error, 'bad_position')
    assert.equal(seekTo({ ...playing, current: { ...playing.current, kind: 'radio', durationMs: null } }, 1000).error, 'unseekable')
    assert.equal(seekTo(playing, 0).ok, true)
    assert.equal(seekTo(createQueueState(), 0).error, 'idle')

    assert.deepEqual(shuffleTracks(waiting, () => 0).map((item) => item.title), ['B', 'C', 'A'])
    assert.equal(parseClock('1:30'), 90_000)
    assert.equal(parseClock('1:02:03'), 3_723_000)
    assert.equal(parseClock('90'), 90_000)
    assert.equal(parseClock('1:99'), null)
    assert.equal(parseClock('-1'), null)

    const topped = insertFront({ ...createQueueState(), tracks: [track('c', 'C')] }, [track('a', 'A'), track('b', 'B')], 2)
    assert.deepEqual(topped.accepted.map((item) => item.title), ['A'])
    assert.equal(topped.rejected, 1)
    assert.deepEqual(topped.state.tracks.map((item) => item.title), ['A', 'C'])
  })
})
