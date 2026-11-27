import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { commandData } from '../src/commands.js'

describe('music commands', () => {
  test('registers playback commands without Administrator', () => {
    const commands = commandData()
    assert.deepEqual(commands.map((command) => command.name), [
      'play', 'playskip', 'playtop', 'pause', 'resume', 'skip', 'back', 'replay', 'stop',
      'queue', 'nowplaying', 'loop', 'shuffle', 'move', 'remove', 'clear', 'seek', 'forward',
      'rewind', 'volume', 'join', 'leave', 'search', 'ping', 'settings', 'setup', 'setdj',
      'setdjonly', 'texttoggle', 'voicetoggle', 'sleep', 'stay', 'filter', 'playlist',
    ])
    const byName = Object.fromEntries(commands.map((command) => [command.name, command]))
    for (const name of ['play', 'skip', 'stop', 'volume']) {
      assert.equal(BigInt(byName[name].default_member_permissions), PermissionFlagsBits.Connect)
      assert.equal(byName[name].dm_permission, false)
      assert.equal((BigInt(byName[name].default_member_permissions) & PermissionFlagsBits.Administrator) === 0n, true)
    }
    assert.equal(byName.queue.default_member_permissions, undefined)
    assert.equal(byName.queue.dm_permission, false)
    for (const name of ['nowplaying', 'ping', 'settings']) {
      assert.equal(byName[name].default_member_permissions, undefined)
      assert.equal(byName[name].dm_permission, false)
    }
    for (const name of ['setup', 'setdj', 'setdjonly', 'texttoggle', 'voicetoggle', 'stay']) {
      assert.equal(BigInt(byName[name].default_member_permissions), PermissionFlagsBits.ManageGuild)
      assert.equal((BigInt(byName[name].default_member_permissions) & PermissionFlagsBits.Administrator) === 0n, true)
    }
    const playlist = byName.playlist.options.map((option) => option.name)
    assert.deepEqual(playlist, ['create', 'add', 'addtrack', 'addqueue', 'show', 'play', 'remove', 'delete', 'share', 'import'])
    const query = byName.play.options.find((option) => option.name === 'query')
    const file = byName.play.options.find((option) => option.name === 'file')
    assert.equal(query.required, false)
    assert.equal(file.required, false)
    const choices = byName.play.options.find((option) => option.name === 'kind').choices.map((choice) => choice.value)
    assert.deepEqual(choices, ['auto', 'soundcloud', 'direct', 'radio'])
    assert.equal(choices.includes('youtube'), false)
  })
})
