import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanels, createProgressLoop } from '../src/runtime.js'
import { PROGRESS_INTERVAL_MS } from '../src/nowplaying.js'

function store() {
  const guilds = {}
  return {
    get(id) { return guilds[id] ?? null },
    put(id, patch) { guilds[id] = { ...guilds[id], ...patch } },
    all() { return guilds },
  }
}

function snapshot(current) {
  return {
    current,
    tracks: [],
    history: [],
    volume: 40,
    loop: 'off',
    filter: 'off',
    paused: false,
    connected: Boolean(current),
    offsetMs: 0,
    startedAt: null,
  }
}

describe('player panel', () => {
  test('does not edit while idle or when the panel is unchanged, and forgets a deleted message', async () => {
    const saved = store()
    saved.put('111111111111111111', {
      panelChannelId: '222222222222222222',
      panelMessageId: '333333333333333333',
    })
    const edits = []
    const panels = createPanels({
      store: saved,
      editMessage: async (_target, body) => { edits.push(body) },
      sendMessage: async () => ({ id: 'new' }),
    })
    let now = 0
    let current = null
    const loop = createProgressLoop({
      music: { snapshot: () => snapshot(current) },
      panels,
      now: () => now,
      schedule: () => ({ cancel() {} }),
      interval: () => ({ cancel() {} }),
    })
    await loop.push('111111111111111111', 'progress')
    assert.equal(edits.length, 0)

    now = PROGRESS_INTERVAL_MS
    current = { title: 'Song', durationMs: 60_000, requestedByTag: 'ada' }
    await loop.push('111111111111111111', 'progress')
    await loop.push('111111111111111111', 'progress')
    assert.equal(edits.length, 1)

    let release
    const gate = new Promise((resolve) => { release = resolve })
    const slowEdits = []
    const slow = createProgressLoop({
      music: {
        snapshot: () => ({ ...snapshot(current), offsetMs: now }),
      },
      panels: {
        get: () => ({ channelId: '222222222222222222', messageId: '333333333333333333' }),
        async edit() {
          slowEdits.push(now)
          now += PROGRESS_INTERVAL_MS
          await gate
        },
        forget() {},
      },
      now: () => now,
      schedule: () => ({ cancel() {} }),
      interval: () => ({ cancel() {} }),
    })
    const pending = slow.push('111111111111111111', 'progress')
    release()
    await pending
    await slow.push('111111111111111111', 'progress')
    assert.equal(slowEdits.length, 2)

    const gone = Object.assign(new Error('missing'), { code: 10008 })
    const forgetting = createProgressLoop({
      music: { snapshot: () => snapshot(current) },
      panels: {
        get: () => panels.get('111111111111111111'),
        edit: async () => { throw gone },
        forget: (id) => panels.forget(id),
      },
      now: () => PROGRESS_INTERVAL_MS,
      schedule: () => ({ cancel() {} }),
      interval: () => ({ cancel() {} }),
    })
    await forgetting.push('111111111111111111', 'action')
    assert.equal(panels.get('111111111111111111'), null)

    const idleEdits = []
    const idlePanels = createPanels({
      store: saved,
      editMessage: async (_target, body) => { idleEdits.push(body) },
      sendMessage: async () => ({ id: 'idle' }),
    })
    saved.put('111111111111111111', {
      panelChannelId: '222222222222222222',
      panelMessageId: '333333333333333333',
    })
    const idleLoop = createProgressLoop({
      music: { snapshot: () => snapshot(null) },
      panels: idlePanels,
      now: () => PROGRESS_INTERVAL_MS,
      schedule: () => ({ cancel() {} }),
      interval: () => ({ cancel() {} }),
    })
    await idleLoop.push('111111111111111111', 'action')
    await idleLoop.push('111111111111111111', 'progress')
    assert.equal(idleEdits.length, 1)
    assert.match(idleEdits[0].embeds[0].toJSON().title, /Nothing playing/)
  })

  test('forgets the panel on unknown channel and missing access too', async () => {
    for (const code of [10003, 50001]) {
      const saved = store()
      saved.put('111111111111111111', { panelChannelId: '1', panelMessageId: '2' })
      const panels = createPanels({
        store: saved,
        editMessage: async () => { throw Object.assign(new Error('no'), { code }) },
        sendMessage: async () => ({ id: '3' }),
      })
      const loop = createProgressLoop({
        music: { snapshot: () => snapshot({ title: 'Song', durationMs: 1000 }) },
        panels,
        now: () => PROGRESS_INTERVAL_MS,
        schedule: () => ({ cancel() {} }),
        interval: () => ({ cancel() {} }),
      })
      await loop.push('111111111111111111', 'action')
      assert.equal(panels.get('111111111111111111'), null)
    }
  })
})
