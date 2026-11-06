import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))
const banned = [/ytdl/i, /yt-dlp/i, /youtube-dl/i, /play-dl/i, /youtubei/i, /pytube/i]

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

describe('music packaging', () => {
  test('dependencies do not include YouTube downloaders', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    assert.ok(names.includes('discord.js'))
    assert.ok(names.includes('@discordjs/voice'))
    for (const name of names) {
      for (const pattern of banned) assert.equal(pattern.test(name), false, name)
    }
    const sources = walk(path.join(root, 'src')).map((file) => readFileSync(file, 'utf8')).join('\n')
    for (const pattern of banned) assert.equal(pattern.test(sources), false, String(pattern))
  })

  test('docker and engines match @discordjs/voice and railway restarts', () => {
    const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
    assert.match(docker, /node:22-slim/)
    assert.match(docker, /22\.12\.0/)
    assert.match(docker, /ffmpeg/)
    assert.match(docker, /USER node/)
    assert.match(docker, /engine-strict|npmrc/)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.engines.node, '>=22.12.0')
    const npmrc = readFileSync(path.join(root, '.npmrc'), 'utf8')
    assert.match(npmrc, /^engine-strict=true$/m)
    const voice = JSON.parse(readFileSync(path.join(root, 'node_modules/@discordjs/voice/package.json'), 'utf8'))
    assert.equal(voice.engines.node, '>=22.12.0')
    const railway = JSON.parse(readFileSync(path.join(root, 'railway.json'), 'utf8'))
    assert.equal(railway.deploy.restartPolicyType, 'ALWAYS')
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8')
    assert.match(ignore, /^config\.json$/m)
    assert.match(ignore, /^\.env$/m)
    const env = readFileSync(path.join(root, '.env.example'), 'utf8')
    assert.match(env, /^DISCORD_BOT_TOKEN=$/m)
    assert.match(env, /^CLIENT_ID=$/m)
    const source = readFileSync(path.join(root, 'src/index.js'), 'utf8')
    assert.doesNotMatch(source, /createServer|listen\(/)
  })

  test('voice stack loads and resolves DAVE', async () => {
    const voice = await import('@discordjs/voice')
    assert.equal(typeof voice.joinVoiceChannel, 'function')
    const report = voice.generateDependencyReport()
    assert.match(report, /@discordjs\/voice/)
    assert.match(report, /@snazzah\/davey: \d/)
    assert.match(report, /opusscript: \d/)
  })
})
