import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { BOT_PERMISSION_NAMES, BOT_PERMISSIONS, inviteUrl } from '../src/permissions.js'

describe('moderator permissions', () => {
  test('invite bits match discord.js and exclude Administrator', () => {
    let expected = 0n
    for (const name of BOT_PERMISSION_NAMES) {
      expected |= PermissionFlagsBits[name]
    }
    assert.equal(BOT_PERMISSIONS, expected)
    assert.equal(BOT_PERMISSIONS, 1099780140054n)
    assert.equal((BOT_PERMISSIONS & PermissionFlagsBits.Administrator) === 0n, true)
    assert.equal(
      inviteUrl('<CLIENT_ID>'),
      'https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=1099780140054',
    )
  })

  test('kit and root READMEs document the invite and intents', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
    const url = inviteUrl('<CLIENT_ID>')
    assert.ok(readme.includes(url))
    assert.ok(root.includes(url))
    for (const intent of ['Guilds', 'GuildMessages', 'MessageContent', 'GuildMembers']) {
      assert.match(readme, new RegExp(intent))
      assert.match(root, new RegExp(intent))
    }
  })
})
