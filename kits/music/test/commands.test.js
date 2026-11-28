import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, PermissionFlagsBits } from 'discord.js'
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
    assert.deepEqual(play.options.map((option) => option.name), ['query'])
    assert.equal(play.options[0].required, true)
    for (const name of ['playskip', 'playtop']) {
      const command = commands.find((entry) => entry.name === name)
      assert.deepEqual(command.options.map((option) => option.name), ['query'])
      assert.equal(command.options[0].required, true)
    }
    const playfile = commands.find((command) => command.name === 'playfile')
    assert.deepEqual(playfile.options.map((option) => option.name), ['file'])
    assert.equal(playfile.options[0].required, true)
    assert.equal(playfile.options[0].type, 11)
    const settings = commands.find((command) => command.name === 'settings')
    assert.equal(BigInt(settings.default_member_permissions), PermissionFlagsBits.ManageGuild)
    const playlist = commands.find((command) => command.name === 'playlist')
    assert.deepEqual(
      playlist.options.map((option) => option.name),
      ['create', 'add', 'addtrack', 'addqueue', 'show', 'play', 'remove', 'delete', 'share', 'import'],
    )
    assert.equal(commands.find((command) => command.name === 'queue').default_member_permissions, undefined)
    const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'))
    assert.deepEqual(schema.$defs.guild.properties.djOnly.items.enum, [...CONTROL_COMMANDS])
    const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement]
    for (const name of ['setup', 'texttoggle']) {
      const option = commands.find((command) => command.name === name).options.find((entry) => entry.name === 'channel')
      assert.deepEqual(option.channel_types, textTypes, name)
    }
  })
})
