// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { BOT_PERMISSIONS, inviteUrl } from '../src/permissions.js'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('feed packaging', () => {
  test('invite, intents, and storage match the documented runtime', () => {
    assert.equal(
      BOT_PERMISSIONS,
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory,
    )
    assert.equal((BOT_PERMISSIONS & PermissionFlagsBits.Administrator) === 0n, true)
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
    assert.ok(readme.includes(inviteUrl('<CLIENT_ID>')))
    assert.match(readme, /not deployable to Vercel/)
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
