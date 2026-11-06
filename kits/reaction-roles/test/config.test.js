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

describe('reaction role config', () => {
  test('guild overrides stay separated and a bad reload keeps the last good file', () => {
    const validate = createValidator(loadSchema(schemaPath))
    assert.equal(parseConfigText(JSON.stringify(example), validate).ok, true)
    assert.equal(guildOptions(example, '111111111111111111').maxOptions, 10)
    assert.equal(guildOptions(example, '999999999999999999').maxOptions, 25)
    const dir = tempDir()
    const filePath = dir.path('config.json')
    writeFileSync(filePath, JSON.stringify(example))
    const store = createConfigStore({
      filePath,
      schema: loadSchema(schemaPath),
      logger: silentLogger,
      watch: false,
    })
    try {
      writeFileSync(filePath, '{')
      assert.equal(store.reloadFromDisk().ok, false)
      assert.equal(store.get().maxOptions, 25)
      writeFileSync(dir.path('bad.json'), '{')
      assert.throws(() => createConfigStore({
        filePath: dir.path('bad.json'),
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
