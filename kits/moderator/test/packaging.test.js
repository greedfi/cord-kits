import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('moderator packaging', () => {
  test('docker uses node 22 slim without ffmpeg and railway stays up', () => {
    const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
    assert.match(docker, /node:22-slim/)
    assert.match(docker, /22\.12\.0/)
    assert.doesNotMatch(docker, /ffmpeg/i)
    assert.match(docker, /USER node/)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.engines.node, '>=22.12.0')
    const npmrc = readFileSync(path.join(root, '.npmrc'), 'utf8')
    assert.match(npmrc, /^engine-strict=true$/m)
    const railway = JSON.parse(readFileSync(path.join(root, 'railway.json'), 'utf8'))
    assert.equal(railway.deploy.restartPolicyType, 'ALWAYS')
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8')
    assert.match(ignore, /^config\.json$/m)
    assert.match(ignore, /^\.env$/m)
    assert.match(ignore, /^data\/$/m)
    const env = readFileSync(path.join(root, '.env.example'), 'utf8')
    assert.match(env, /^DISCORD_BOT_TOKEN=$/m)
    assert.match(env, /^CLIENT_ID=$/m)
    assert.ok(pkg.dependencies['discord.js'])
    assert.equal(pkg.dependencies['@discordjs/voice'], undefined)
  })
})
