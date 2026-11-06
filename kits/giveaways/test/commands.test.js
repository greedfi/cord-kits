// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, Routes } from 'discord.js'
import { commandData } from '../src/commands.js'
import { registrationTarget, validateCommandPayload } from '../src/register.js'

describe('giveaway commands', () => {
  test('payload disables DMs, limits manage-guild, and matches the Discord route', () => {
    const body = validateCommandPayload(commandData())
    assert.deepEqual(body.map((command) => command.name), ['giveaway'])
    assert.equal(body[0].dm_permission, false)
    assert.equal(BigInt(body[0].default_member_permissions), PermissionFlagsBits.ManageGuild)
    assert.deepEqual(body[0].options.map((option) => option.name), ['create', 'end', 'cancel', 'reroll'])
    const clientId = '123456789012345678'
    const guildId = '223456789012345678'
    assert.equal(registrationTarget(clientId).path, Routes.applicationCommands(clientId))
    assert.equal(
      registrationTarget(clientId, guildId).path,
      Routes.applicationGuildCommands(clientId, guildId),
    )
    assert.throws(() => registrationTarget('nope'), /CLIENT_ID/)
  })
})
