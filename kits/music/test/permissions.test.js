import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js'
import {
  BASE_INTENTS,
  BASE_PERMISSION_NAMES,
  BOT_PERMISSIONS,
  REQUEST_AND_STATUS_PERMISSIONS,
  REQUEST_CHANNEL_PERMISSIONS,
  REQUEST_INTENTS,
  VOICE_STATUS_PERMISSION,
  VOICE_STATUS_PERMISSIONS,
  gatewayIntents,
  inviteUrl,
} from '../src/permissions.js'

describe('music permissions', () => {
  test('the base invite excludes Administrator and privileged intents', () => {
    assert.equal(BOT_PERMISSIONS, 3165184n)
    assert.equal((BOT_PERMISSIONS & PermissionFlagsBits.Administrator) === 0n, true)
    assert.equal((BOT_PERMISSIONS & PermissionFlagsBits.ManageMessages) === 0n, true)
    assert.equal((BOT_PERMISSIONS & VOICE_STATUS_PERMISSION) === 0n, true)
    assert.deepEqual(BASE_PERMISSION_NAMES, ['ViewChannel', 'SendMessages', 'EmbedLinks', 'Connect', 'Speak'])
    assert.equal(VOICE_STATUS_PERMISSION, 1n << 48n)
    assert.equal(REQUEST_CHANNEL_PERMISSIONS, 3173376n)
    assert.equal(VOICE_STATUS_PERMISSIONS, 281474979875840n)
    assert.equal(REQUEST_AND_STATUS_PERMISSIONS, 281474979884032n)
    assert.deepEqual(gatewayIntents(false), [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates])
    assert.equal(gatewayIntents(false).includes(GatewayIntentBits.MessageContent), false)
    assert.deepEqual(gatewayIntents(true), [...BASE_INTENTS, ...REQUEST_INTENTS])
    assert.equal(gatewayIntents(true).includes(GatewayIntentBits.MessageContent), true)
    assert.equal(
      inviteUrl('<CLIENT_ID>'),
      'https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3165184',
    )
  })

  test('kit and root READMEs document the base invite and the opt-in extras', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
    const url = inviteUrl('<CLIENT_ID>')
    assert.ok(readme.includes(url))
    assert.ok(root.includes(url))
    assert.match(readme, /GuildVoiceStates/)
    assert.match(readme, /3165184/)
    assert.match(readme, /3173376/)
    assert.match(readme, /281474979875840/)
    assert.match(readme, /Message Content/)
    assert.match(readme, /22\.12/)
    assert.match(root, /22\.12/)
  })
})
