// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js'
import { BOT_PERMISSIONS, inviteUrl } from '../src/permissions.js'
import { INTENTS } from '../src/runtime.js'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('welcome packaging', () => {
  test('invite and intents match the documented runtime', () => {
    assert.equal(
      BOT_PERMISSIONS,
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ManageRoles,
    )
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
    assert.ok(readme.includes(inviteUrl('<CLIENT_ID>')))
    assert.match(readme, /not identity verification/)
    assert.ok(INTENTS.includes(GatewayIntentBits.GuildMembers))
    assert.equal(INTENTS.includes(GatewayIntentBits.MessageContent), false)
    const runtime = readFileSync(path.join(root, 'src/runtime.js'), 'utf8')
    assert.match(runtime, /GatewayIntentBits\.GuildMembers/)
    assert.doesNotMatch(runtime, /MessageContent|createServer/)
  })
})
