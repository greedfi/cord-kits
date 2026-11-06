// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { BOT_PERMISSIONS, inviteUrl } from '../src/permissions.js'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('reaction role packaging', () => {
  test('invite, intents, and storage match the documented runtime', () => {
    let expected = 0n
    for (const name of ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageRoles']) {
      expected |= PermissionFlagsBits[name]
    }
    assert.equal(BOT_PERMISSIONS, expected)
    assert.equal((BOT_PERMISSIONS & PermissionFlagsBits.Administrator) === 0n, true)
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
    assert.ok(readme.includes(inviteUrl('<CLIENT_ID>')))
    assert.match(readme, /not an emoji reaction/)
    const source = readFileSync(path.join(root, 'src/index.js'), 'utf8')
    assert.match(source, /GatewayIntentBits\.Guilds/)
    assert.doesNotMatch(source, /MessageContent|GuildMembers|createServer/)
    const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
    assert.match(docker, /node:22-slim/)
    assert.match(docker, /DATA_DIR=\/data/)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.engines.node, '>=22.12.0')
  })
})
