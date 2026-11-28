import fs from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlaylistStore, MAX_PLAYLISTS_PER_GUILD, MAX_TRACKS_PER_PLAYLIST } from '../src/playlists.js'
import { tempDir } from './helpers.js'

const guild = '111111111111111111'
const other = '222222222222222222'
const owner = '333333333333333333'
const stranger = '444444444444444444'
const track = (index) => ({
  kind: 'soundcloud',
  title: `Track ${index}`,
  url: `https://soundcloud.com/artist/${index}`,
  durationMs: 1000,
  soundcloudId: String(index),
  artist: 'Ada',
})

function open(dir, fsImpl = fs) {
  return createPlaylistStore({ file: dir.path('playlists.json'), fsImpl })
}

describe('playlists', () => {
  test('survives a restart, keeps ownership, and imports a read-only copy', () => {
    const dir = tempDir()
    try {
      const first = open(dir)
      assert.equal(first.create({ guildId: guild, ownerId: owner, name: '@nope' }).error, 'bad_name')
      assert.equal(first.create({ guildId: guild, ownerId: owner, name: 'Night' }).ok, true)
      assert.equal(first.addTracks({
        guildId: guild, actorId: stranger, manage: false, name: 'Night', tracks: [track(1)],
      }).error, 'forbidden')
      assert.equal(first.addTracks({
        guildId: guild, actorId: owner, manage: false, name: 'Night', tracks: [track(1), track(2)],
      }).accepted.length, 2)
      const restarted = open(dir)
      assert.equal(restarted.find(guild, 'Night').tracks.length, 2)
      const code = restarted.share({ guildId: guild, actorId: owner, manage: false, name: 'Night' }).shareCode
      const imported = restarted.importCode({ guildId: other, ownerId: stranger, code })
      assert.equal(imported.ok, true)
      assert.equal(imported.playlist.imported, true)
      assert.equal(restarted.addTracks({
        guildId: other, actorId: stranger, manage: true, name: imported.playlist.name, tracks: [track(3)],
      }).error, 'readonly')
      assert.equal(restarted.delete({
        guildId: other, actorId: stranger, manage: false, name: imported.playlist.name,
      }).ok, true)
      assert.equal(restarted.find(guild, 'Night').tracks.length, 2)
      assert.equal(restarted.importCode({ guildId: guild, ownerId: owner, code }).error, 'same_guild')
    } finally {
      dir.remove()
    }
  })

  test('a failed write keeps the previous playlist and a corrupt file falls back to the backup', () => {
    const dir = tempDir()
    let fail = true
    const fsImpl = {
      mkdirSync: (...args) => fs.mkdirSync(...args),
      openSync: (...args) => fs.openSync(...args),
      writeSync: (...args) => fs.writeSync(...args),
      fsyncSync: (...args) => fs.fsyncSync(...args),
      closeSync: (...args) => fs.closeSync(...args),
      existsSync: (...args) => fs.existsSync(...args),
      copyFileSync: (...args) => fs.copyFileSync(...args),
      readFileSync: (...args) => fs.readFileSync(...args),
      renameSync(...args) {
        if (fail) throw new Error('disk')
        return fs.renameSync(...args)
      },
    }
    try {
      const store = open(dir, fsImpl)
      assert.throws(() => store.create({ guildId: guild, ownerId: owner, name: 'One' }), /disk/)
      fail = false
      assert.equal(store.create({ guildId: guild, ownerId: owner, name: 'One' }).ok, true)
      assert.equal(store.create({ guildId: guild, ownerId: owner, name: 'Two' }).ok, true)
      fs.writeFileSync(dir.path('playlists.json'), '{')
      const recovered = open(dir)
      assert.deepEqual(recovered.list(guild).map((playlist) => playlist.name), ['One'])
    } finally {
      dir.remove()
    }
  })

  test('enforces the playlist and track caps', () => {
    const dir = tempDir()
    try {
      const store = open(dir)
      for (let index = 0; index < MAX_PLAYLISTS_PER_GUILD; index += 1) {
        assert.equal(store.create({ guildId: guild, ownerId: owner, name: `List ${index}` }).ok, true)
      }
      assert.equal(store.create({ guildId: guild, ownerId: owner, name: 'Overflow' }).error, 'too_many')
      const tracks = Array.from({ length: MAX_TRACKS_PER_PLAYLIST + 1 }, (_item, index) => track(index))
      const added = store.addTracks({
        guildId: guild, actorId: owner, manage: false, name: 'List 0', tracks,
      })
      assert.equal(added.accepted.length, MAX_TRACKS_PER_PLAYLIST)
      assert.equal(added.rejected, 1)
      assert.equal(store.addTracks({
        guildId: guild, actorId: owner, manage: false, name: 'List 0', tracks: [track(999)],
      }).error, 'full')
    } finally {
      dir.remove()
    }
  })
})
