import { readFileSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  ConfigError,
  createConfigStore,
  loadSchema,
  parseConfigText,
  createValidator,
} from '../src/config.js'
import { silentLogger, tempDir, waitFor } from './helpers.js'

const schemaPath = fileURLToPath(new URL('../config.schema.json', import.meta.url))
const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))

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

describe('music config', () => {
  test('example config matches the schema', () => {
    const validate = createValidator(loadSchema(schemaPath))
    const result = parseConfigText(JSON.stringify(example), validate)
    assert.equal(result.ok, true)
    assert.equal(result.config.defaultVolume, 50)
  })

  test('rejects invalid JSON and schema violations on first load', () => {
    assert.throws(() => storeFrom('{'), ConfigError)
    assert.throws(() => storeFrom(JSON.stringify({ defaultVolume: 50 })), ConfigError)
    assert.throws(() => storeFrom(JSON.stringify({
      ...example,
      defaultVolume: 101,
    })), ConfigError)
    assert.throws(() => storeFrom(JSON.stringify({
      ...example,
      extra: true,
    })), ConfigError)
  })

  test('reload of bad JSON keeps the last good config and logs', () => {
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
      const result = store.reloadFromDisk()
      assert.equal(result.ok, false)
      assert.equal(store.get().defaultVolume, 50)
      assert.equal(store.get().maxQueueSize, 100)
      assert.ok(errors.some((message) => message.includes('Keeping last good config')))
    } finally {
      store.close()
      dir.remove()
    }
  })

  test('reload of a valid file replaces the config', () => {
    const { dir, filePath, store } = storeFrom(JSON.stringify(example))
    try {
      const next = { ...example, defaultVolume: 15 }
      writeFileSync(filePath, JSON.stringify(next))
      const result = store.reloadFromDisk()
      assert.equal(result.ok, true)
      assert.equal(store.get().defaultVolume, 15)
    } finally {
      store.close()
      dir.remove()
    }
  })

  test('a schema failure on reload keeps the last good config', () => {
    const errors = []
    const { dir, filePath, store } = storeFrom(JSON.stringify(example), {
      logger: {
        info() {},
        error(message) {
          errors.push(message)
        },
      },
    })
    try {
      writeFileSync(filePath, JSON.stringify({ ...example, defaultVolume: -1 }))
      const result = store.reloadFromDisk()
      assert.equal(result.ok, false)
      assert.equal(store.get().defaultVolume, 50)
      assert.ok(errors.some((message) => message.includes('Keeping last good config')))
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
      const next = { ...example, defaultVolume: 22 }
      writeFileSync(filePath, `${JSON.stringify(next)}\n`)
      await waitFor(() => store.get().defaultVolume === 22)
      writeFileSync(filePath, '{')
      await waitFor(() => errors.some((message) => message.includes('Keeping last good config')))
      assert.equal(store.get().defaultVolume, 22)
    } finally {
      store.close()
      dir.remove()
    }
  })
})
