// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BOT_PERMISSIONS, inviteUrl } from '../src/permissions.js'
import { PermissionFlagsBits } from 'discord.js'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('giveaway packaging', () => {
  test('invite, runtime, and storage stay explicit', () => {
    let expected = 0n
    for (const name of ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory']) {
      expected |= PermissionFlagsBits[name]
    }
    assert.equal(BOT_PERMISSIONS, expected)
    assert.equal((BOT_PERMISSIONS & PermissionFlagsBits.Administrator) === 0n, true)
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
    const rootReadme = readFileSync(path.join(root, '../../README.md'), 'utf8')
    assert.ok(readme.includes(inviteUrl('<CLIENT_ID>')))
    assert.ok(rootReadme.includes('giveaways'))
    const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
    assert.match(docker, /node:22-slim/)
    assert.match(docker, /DATA_DIR=\/data/)
    assert.doesNotMatch(docker, /ffmpeg/i)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.engines.node, '>=22.12.0')
    const source = readFileSync(path.join(root, 'src/index.js'), 'utf8')
    assert.match(source, /GatewayIntentBits\.Guilds/)
    assert.doesNotMatch(source, /MessageContent|GuildMembers|createServer/)
    const railway = JSON.parse(readFileSync(path.join(root, 'railway.json'), 'utf8'))
    assert.equal(railway.deploy.restartPolicyType, 'ALWAYS')
  })
})
