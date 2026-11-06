// Automated tests with mocked Discord boundaries. These are not live Discord tests.
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
import { silentLogger, tempDir } from './helpers.js'
import { guildOptions } from '../src/runtime.js'

const schemaPath = fileURLToPath(new URL('../config.schema.json', import.meta.url))
const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))

describe('giveaway config', () => {
  test('example matches the schema and guild overrides do not leak', () => {
    const validate = createValidator(loadSchema(schemaPath))
    assert.equal(parseConfigText(JSON.stringify(example), validate).ok, true)
    const guild = '111111111111111111'
    const other = '999999999999999999'
    assert.equal(guildOptions(example, guild).maxWinners, 3)
    assert.equal(guildOptions(example, guild).minAccountAgeMs, 24 * 3_600_000)
    assert.equal(guildOptions(example, other).maxWinners, example.maxWinners)
    assert.equal(guildOptions(example, other).minAccountAgeMs, 0)
    const extra = { ...example, port: 80 }
    assert.equal(parseConfigText(JSON.stringify(extra), validate).ok, false)
  })

  test('an invalid reload keeps the last good config', () => {
    const dir = tempDir()
    const filePath = dir.path('config.json')
    writeFileSync(filePath, JSON.stringify(example))
    const errors = []
    const store = createConfigStore({
      filePath,
      schema: loadSchema(schemaPath),
      logger: {
        info() {},
        error(message) {
          errors.push(message)
        },
      },
      watch: false,
    })
    try {
      writeFileSync(filePath, '{')
      assert.equal(store.reloadFromDisk().ok, false)
      assert.equal(store.get().maxWinners, 10)
      assert.ok(errors.some((message) => message.includes('Keeping last good config')))
      const broken = dir.path('broken.json')
      writeFileSync(broken, '{')
      assert.throws(() => createConfigStore({
        filePath: broken,
        schema: loadSchema(schemaPath),
        logger: silentLogger,
        watch: false,
      }), ConfigError)
    } finally {
      store.close()
      dir.remove()
    }
  })
})
