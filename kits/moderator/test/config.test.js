import { readFileSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  ConfigError,
  createConfigStore,
  createValidator,
  loadSchema,
  parseConfigText,
} from '../src/config.js'
import { defaultGuildSettings, setRaidEnabled } from '../src/settings.js'
import { silentLogger, tempDir, waitFor } from './helpers.js'

const schemaPath = fileURLToPath(new URL('../config.schema.json', import.meta.url))
const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
const guildId = '111111111111111111'

function storeFrom(text, { watch = false, logger = silentLogger } = {}) {
  const dir = tempDir()
  const filePath = dir.path('config.json')
  writeFileSync(filePath, text)
  const store = createConfigStore({
    filePath,
    schema: loadSchema(schemaPath),
    logger,
    watch,
    debounceMs: 30,
  })
  return { dir, filePath, store }
}

describe('moderator config', () => {
  test('example config and generated guild defaults match the schema', () => {
    const validate = createValidator(loadSchema(schemaPath))
    assert.equal(parseConfigText(JSON.stringify(example), validate).ok, true)
    const generated = { guilds: { [guildId]: defaultGuildSettings() } }
    assert.equal(parseConfigText(JSON.stringify(generated), validate).ok, true)
    const toggled = setRaidEnabled(generated, guildId, true)
    assert.equal(toggled.guilds[guildId].raidMode.enabled, true)
    assert.equal(parseConfigText(JSON.stringify(toggled), validate).ok, true)
    const created = setRaidEnabled({ guilds: {} }, '444444444444444444', true)
    assert.equal(parseConfigText(JSON.stringify(created), validate).ok, true)
  })

  test('rejects a role hold without roleId, a bad domain, and extra fields', () => {
    const validate = createValidator(loadSchema(schemaPath))
    const roleHold = structuredClone(example)
    roleHold.guilds[guildId].raidMode.joinHold = {
      type: 'role',
      timeoutMinutes: 10,
      roleId: null,
    }
    assert.equal(parseConfigText(JSON.stringify(roleHold), validate).ok, false)
    const badDomain = structuredClone(example)
    badDomain.guilds[guildId].linkFilter.domains = ['https://example.com']
    assert.equal(parseConfigText(JSON.stringify(badDomain), validate).ok, false)
    const extra = { ...example, extra: true }
    assert.equal(parseConfigText(JSON.stringify(extra), validate).ok, false)
    assert.throws(() => storeFrom('{'), ConfigError)
  })

  test('reload keeps the last good config when JSON or the schema is bad', () => {
    const errors = []
    const logger = {
      info() {},
      error(message) {
        errors.push(message)
      },
    }
    const { dir, filePath, store } = storeFrom(JSON.stringify(example), { logger })
    try {
      writeFileSync(filePath, '{')
      assert.equal(store.reloadFromDisk().ok, false)
      assert.equal(store.get().guilds[guildId].raidMode.slowmodeSeconds, 10)
      writeFileSync(filePath, JSON.stringify({ guilds: { [guildId]: { modLogChannelId: null } } }))
      assert.equal(store.reloadFromDisk().ok, false)
      assert.equal(store.get().guilds[guildId].wordFilter.enabled, false)
      assert.ok(errors.filter((message) => message.includes('Keeping last good config')).length >= 2)
    } finally {
      store.close()
      dir.remove()
    }
  })

  test('a valid reload replaces settings', () => {
    const { dir, filePath, store } = storeFrom(JSON.stringify(example))
    try {
      const next = structuredClone(example)
      next.guilds[guildId].raidMode.slowmodeSeconds = 30
      writeFileSync(filePath, JSON.stringify(next))
      assert.equal(store.reloadFromDisk().ok, true)
      assert.equal(store.get().guilds[guildId].raidMode.slowmodeSeconds, 30)
    } finally {
      store.close()
      dir.remove()
    }
  })

  test('fs.watch reloads a good file and ignores a bad write', async () => {
    const errors = []
    const { dir, filePath, store } = storeFrom(`${JSON.stringify(example)}\n`, {
      watch: true,
      logger: {
        info() {},
        error(message) {
          errors.push(message)
        },
      },
    })
    try {
      const next = structuredClone(example)
      next.guilds[guildId].raidMode.slowmodeSeconds = 45
      writeFileSync(filePath, `${JSON.stringify(next)}\n`)
      await waitFor(() => store.get().guilds[guildId].raidMode.slowmodeSeconds === 45)
      writeFileSync(filePath, '{')
      await waitFor(() => errors.some((message) => message.includes('Keeping last good config')))
      assert.equal(store.get().guilds[guildId].raidMode.slowmodeSeconds, 45)
    } finally {
      store.close()
      dir.remove()
    }
  })
})
