import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { commandData } from '../src/commands.js'

describe('music commands', () => {
  test('registers play, skip, queue, stop, and volume without Administrator', () => {
    const commands = commandData()
    assert.deepEqual(commands.map((command) => command.name), ['play', 'skip', 'queue', 'stop', 'volume'])
    const byName = Object.fromEntries(commands.map((command) => [command.name, command]))
    for (const name of ['play', 'skip', 'stop', 'volume']) {
      assert.equal(BigInt(byName[name].default_member_permissions), PermissionFlagsBits.Connect)
      assert.equal(byName[name].dm_permission, false)
      assert.equal((BigInt(byName[name].default_member_permissions) & PermissionFlagsBits.Administrator) === 0n, true)
    }
    assert.equal(byName.queue.default_member_permissions, undefined)
    assert.equal(byName.queue.dm_permission, false)
    const query = byName.play.options.find((option) => option.name === 'query')
    const file = byName.play.options.find((option) => option.name === 'file')
    assert.equal(query.required, false)
    assert.equal(file.required, false)
    const choices = byName.play.options.find((option) => option.name === 'kind').choices.map((choice) => choice.value)
    assert.deepEqual(choices, ['auto', 'soundcloud', 'direct', 'radio'])
    assert.equal(choices.includes('youtube'), false)
  })
})
