import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { commandData } from '../src/commands.js'

describe('moderator commands', () => {
  test('sets moderation permissions and never Administrator', () => {
    const commands = commandData()
    assert.deepEqual(
      commands.map((command) => command.name),
      ['warn', 'timeout', 'kick', 'ban', 'purge', 'raid'],
    )
    const byName = Object.fromEntries(commands.map((command) => [command.name, command]))
    const expected = {
      warn: PermissionFlagsBits.ModerateMembers,
      timeout: PermissionFlagsBits.ModerateMembers,
      kick: PermissionFlagsBits.KickMembers,
      ban: PermissionFlagsBits.BanMembers,
      purge: PermissionFlagsBits.ManageMessages,
      raid: PermissionFlagsBits.ModerateMembers,
    }
    for (const [name, bits] of Object.entries(expected)) {
      assert.equal(BigInt(byName[name].default_member_permissions), bits, name)
      assert.equal(byName[name].dm_permission, false)
      assert.equal((BigInt(byName[name].default_member_permissions) & PermissionFlagsBits.Administrator) === 0n, true)
    }
  })
})
