// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, Routes } from 'discord.js'
import { commandData } from '../src/commands.js'
import { registrationTarget, validateCommandPayload } from '../src/register.js'

describe('ticket commands', () => {
  test('open is available in servers and panel and transcript require Manage Channels', () => {
    const body = validateCommandPayload(commandData())
    assert.equal(body[0].dm_permission, false)
    const byName = Object.fromEntries(body[0].options.map((option) => [option.name, option]))
    assert.equal(BigInt(byName.panel.default_member_permissions), PermissionFlagsBits.ManageChannels)
    assert.equal(BigInt(byName.transcript.default_member_permissions), PermissionFlagsBits.ManageChannels)
    assert.equal(byName.open.default_member_permissions, undefined)
    const clientId = '123456789012345678'
    assert.equal(registrationTarget(clientId).path, Routes.applicationCommands(clientId))
  })
})
