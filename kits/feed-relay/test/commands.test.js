// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, Routes } from 'discord.js'
import { commandData } from '../src/commands.js'
import { registrationTarget, validateCommandPayload } from '../src/register.js'

describe('feed commands', () => {
  test('status is guild-only and matches the Discord route', () => {
    const body = validateCommandPayload(commandData())
    assert.equal(body[0].name, 'feed')
    assert.equal(body[0].dm_permission, false)
    assert.equal(BigInt(body[0].default_member_permissions), PermissionFlagsBits.ManageGuild)
    const clientId = '123456789012345678'
    assert.equal(registrationTarget(clientId).path, Routes.applicationCommands(clientId))
  })
})
