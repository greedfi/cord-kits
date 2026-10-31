import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { BOT_PERMISSION_NAMES, BOT_PERMISSIONS, inviteUrl } from '../src/permissions.js'

describe('music permissions', () => {
  test('invite bits match discord.js and exclude Administrator', () => {
    let expected = 0n
    for (const name of BOT_PERMISSION_NAMES) {
      assert.equal(PermissionFlagsBits[name] > 0n, true, name)
      expected |= PermissionFlagsBits[name]
    }
    assert.equal(BOT_PERMISSIONS, expected)
    assert.equal(BOT_PERMISSIONS, 3148800n)
    assert.equal((BOT_PERMISSIONS & PermissionFlagsBits.Administrator) === 0n, true)
    assert.equal(
      inviteUrl('<CLIENT_ID>'),
      'https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3148800',
    )
  })

  test('kit and root READMEs document the invite', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
    const url = inviteUrl('<CLIENT_ID>')
    assert.ok(readme.includes(url))
    assert.ok(root.includes(url))
    assert.match(readme, /GuildVoiceStates/)
    assert.match(readme, /Guilds/)
  })
})
