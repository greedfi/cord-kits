import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BUTTON_COMMANDS } from '../src/catalog.js'
import {
  MIN_EDIT_GAP_MS,
  PROGRESS_INTERVAL_MS,
  editDecision,
  nowPlayingPayload,
  progressLine,
  searchMenu,
} from '../src/nowplaying.js'

const snapshot = {
  current: {
    title: 'x'.repeat(400),
    url: 'https://soundcloud.com/artist/song',
    durationMs: 180_000,
    requestedByTag: '<@123> @everyone ada',
  },
  tracks: [{ title: 'Next' }],
  history: [{}],
  volume: 40,
  loop: 'song',
  filter: '8d',
  paused: false,
  connected: true,
  offsetMs: 30_000,
  startedAt: null,
}

describe('now playing', () => {
  test('stays inside Discord embed and component limits', () => {
    const payload = nowPlayingPayload(snapshot, 0)
    const embed = payload.embeds[0].toJSON()
    const fieldLength = embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
    assert.ok(embed.title.length <= 256)
    assert.ok(embed.description.length <= 4096)
    assert.equal(embed.fields.length <= 25, true)
    assert.equal(embed.title.length + embed.description.length + fieldLength <= 6000, true)
    assert.equal(embed.description.includes('@'), false)
    assert.equal(payload.components.length <= 5, true)
    for (const row of payload.components) {
      const json = row.toJSON()
      assert.ok(json.components.length <= 5)
      for (const component of json.components) {
        assert.ok(component.custom_id.length <= 100)
        assert.ok(component.label.length <= 80)
        assert.equal(BUTTON_COMMANDS[component.custom_id] != null, true)
      }
    }
    const menu = searchMenu(Array.from({ length: 12 }, () => ({
      title: 'y'.repeat(180),
      artist: 'z'.repeat(180),
    }))).components[0].toJSON().components[0]
    assert.equal(menu.options.length, 10)
    assert.ok(menu.options.every((option) => option.label.length <= 100 && option.value.length <= 100))
    assert.match(progressLine(30_000, 180_000), /0:30 \/ 3:00/)
    assert.equal(progressLine(0, null), 'live')
  })

  test('progress edits wait and control edits can trail', () => {
    assert.equal(editDecision({ now: 1000, lastEditAt: 0, reason: 'progress' }), 'wait')
    assert.equal(editDecision({ now: PROGRESS_INTERVAL_MS, lastEditAt: 0, reason: 'progress' }), 'edit')
    assert.equal(editDecision({ now: 1000, lastEditAt: 0, reason: 'action' }), 'trail')
    assert.equal(editDecision({ now: MIN_EDIT_GAP_MS, lastEditAt: 0, reason: 'action' }), 'edit')
  })
})
