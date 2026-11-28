import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function loadEnv(file = '.env') {
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and set it.`)
  }
  return value
}

export function redact(text) {
  let value = String(text)
  for (const name of ['DISCORD_BOT_TOKEN', 'SOUNDCLOUD_CLIENT_ID']) {
    const secret = process.env[name]?.trim()
    if (secret) value = value.split(secret).join('[redacted]')
  }
  return value.replace(/([?&]client_id=)[^&\s]+/gi, '$1[redacted]')
}

export function requestChannelEnabled(env = process.env) {
  const raw = env.ENABLE_REQUEST_CHANNEL?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export function dataDir() {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), 'data')
}

export function isDirectRun(metaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  return metaUrl === pathToFileURL(path.resolve(entry)).href
}
