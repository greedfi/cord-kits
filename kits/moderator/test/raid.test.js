import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRaidSync,
  desiredSlowmodes,
  joinHoldAction,
  planSlowmodeSync,
} from '../src/raid.js'
import { tempDir } from './helpers.js'

describe('raid mode', () => {
  test('desired slowmodes follow the enabled flag', () => {
    assert.equal(desiredSlowmodes({
      enabled: false,
      channelIds: ['1'],
      slowmodeSeconds: 10,
    }).size, 0)
    const desired = desiredSlowmodes({
      enabled: true,
      channelIds: ['111111111111111111', '222222222222222222'],
      slowmodeSeconds: 10,
    })
    assert.equal(desired.get('111111111111111111'), 10)
    assert.equal(desired.size, 2)
  })

  test('sync stores the previous slowmode, updates, and restores', () => {
    const raid = createRaidSync()
    const first = raid.plan('g', new Map([['c', 10]]), () => 2)
    assert.deepEqual(first.changes, [{ id: 'c', slowmodeSeconds: 10 }])
    assert.equal(first.state.get('c').previous, 2)
    const same = raid.plan('g', new Map([['c', 10]]), () => 999)
    assert.deepEqual(same.changes, [])
    assert.equal(same.state.get('c').previous, 2)
    const changed = raid.plan('g', new Map([['c', 30], ['d', 30]]), (id) => (id === 'd' ? 5 : 0))
    assert.deepEqual(changed.changes, [
      { id: 'c', slowmodeSeconds: 30 },
      { id: 'd', slowmodeSeconds: 30 },
    ])
    assert.equal(changed.state.get('c').previous, 2)
    assert.equal(changed.state.get('d').previous, 5)
    const dropped = raid.plan('g', new Map([['d', 30]]), () => 0)
    assert.deepEqual(dropped.changes, [{ id: 'c', slowmodeSeconds: 2 }])
    const off = raid.plan('g', new Map(), () => 0)
    assert.deepEqual(off.changes, [{ id: 'd', slowmodeSeconds: 5 }])
    assert.equal(off.state.size, 0)
  })

  test('guild snapshots do not leak, including across a restart', () => {
    const dir = tempDir()
    const filePath = dir.path('raid-snapshots.json')
    try {
      const first = createRaidSync({ filePath })
      first.plan('guild-a', new Map([['a', 10]]), () => 0)
      first.plan('guild-b', new Map([['b', 20]]), () => 4)
      const second = createRaidSync({ filePath })
      const again = second.plan('guild-a', new Map([['a', 10]]), () => 99)
      assert.deepEqual(again.changes, [])
      assert.equal(again.state.get('a').previous, 0)
      assert.equal(second.state('guild-b').get('b').previous, 4)
      const off = second.plan('guild-a', new Map(), () => 0)
      assert.deepEqual(off.changes, [{ id: 'a', slowmodeSeconds: 0 }])
      const disk = JSON.parse(readFileSync(filePath, 'utf8'))
      assert.equal(disk['guild-a'], undefined)
      assert.equal(disk['guild-b'].b.previous, 4)
    } finally {
      dir.remove()
    }
  })

  test('join hold is off unless raid mode is enabled', () => {
    assert.deepEqual(joinHoldAction({
      enabled: false,
      joinHold: { type: 'timeout', timeoutMinutes: 5 },
    }), { type: 'off' })
    assert.deepEqual(joinHoldAction({
      enabled: true,
      joinHold: { type: 'timeout', timeoutMinutes: 5 },
    }), { type: 'timeout', minutes: 5, timeoutMs: 300_000 })
    assert.deepEqual(joinHoldAction({
      enabled: true,
      joinHold: { type: 'role', roleId: null },
    }), { type: 'error', error: 'role_missing' })
    assert.deepEqual(joinHoldAction({
      enabled: true,
      joinHold: { type: 'role', roleId: '333333333333333333' },
    }), { type: 'role', roleId: '333333333333333333' })
    assert.deepEqual(joinHoldAction({
      enabled: true,
      joinHold: { type: 'off', timeoutMinutes: 5, roleId: null },
    }), { type: 'off' })
  })

  test('planSlowmodeSync does not mutate the previous map', () => {
    const before = new Map([['c', { previous: 1, applied: 10 }]])
    const result = planSlowmodeSync(before, new Map([['c', 12]]), () => 0)
    assert.equal(before.get('c').applied, 10)
    assert.equal(result.state.get('c').applied, 12)
    assert.equal(result.state.get('c').previous, 1)
  })
})
