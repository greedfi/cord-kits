import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('moderator packaging', () => {
  test('docker uses node 20 slim without ffmpeg and railway stays up', () => {
    const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
    assert.match(docker, /node:20-slim/)
    assert.doesNotMatch(docker, /ffmpeg/i)
    assert.match(docker, /USER node/)
    const railway = JSON.parse(readFileSync(path.join(root, 'railway.json'), 'utf8'))
    assert.equal(railway.deploy.restartPolicyType, 'ALWAYS')
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8')
    assert.match(ignore, /^config\.json$/m)
    assert.match(ignore, /^\.env$/m)
    assert.match(ignore, /^data\/$/m)
    const env = readFileSync(path.join(root, '.env.example'), 'utf8')
    assert.match(env, /^DISCORD_BOT_TOKEN=$/m)
    assert.match(env, /^CLIENT_ID=$/m)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.ok(pkg.dependencies['discord.js'])
    assert.equal(pkg.dependencies['@discordjs/voice'], undefined)
  })
})
