import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { CONFIG_COMMANDS, CONTROL_COMMANDS, OPEN_COMMANDS } from '../src/catalog.js'
import { commandData } from '../src/commands.js'

describe('music commands', () => {
  test('registers the player, settings, and playlist commands without Administrator', () => {
    const commands = commandData()
    assert.deepEqual(
      commands.map((command) => command.name).sort(),
      [...CONTROL_COMMANDS, ...CONFIG_COMMANDS, ...OPEN_COMMANDS].sort(),
    )
    const dj = commands.find((command) => command.name === 'setdjonly')
    assert.deepEqual(
      dj.options[0].choices.map((choice) => choice.value),
      CONTROL_COMMANDS,
    )
    assert.ok(dj.options[0].choices.length <= 25)
    for (const command of commands) {
      assert.equal(command.dm_permission, false, command.name)
      assert.ok(command.description.length > 0 && command.description.length <= 100, command.name)
      const permissions = command.default_member_permissions
      if (permissions != null) {
        const bits = BigInt(permissions)
        assert.equal((bits & PermissionFlagsBits.Administrator) === 0n, true, command.name)
      }
      for (const option of command.options ?? []) {
        assert.ok((option.description ?? '').length <= 100, `${command.name}.${option.name}`)
        assert.ok((option.choices ?? []).length <= 25, `${command.name}.${option.name}`)
      }
    }
    const play = commands.find((command) => command.name === 'play')
    assert.equal(BigInt(play.default_member_permissions), PermissionFlagsBits.Connect)
    const query = play.options.find((option) => option.name === 'query')
    assert.equal(query.required, false)
    const kind = play.options.find((option) => option.name === 'kind')
    assert.deepEqual(kind.choices.map((choice) => choice.value), ['auto', 'soundcloud', 'direct', 'radio'])
    const settings = commands.find((command) => command.name === 'settings')
    assert.equal(BigInt(settings.default_member_permissions), PermissionFlagsBits.ManageGuild)
    const playlist = commands.find((command) => command.name === 'playlist')
    assert.deepEqual(
      playlist.options.map((option) => option.name),
      ['create', 'add', 'addtrack', 'addqueue', 'show', 'play', 'remove', 'delete', 'share', 'import'],
    )
    assert.equal(commands.find((command) => command.name === 'queue').default_member_permissions, undefined)
  })
})
