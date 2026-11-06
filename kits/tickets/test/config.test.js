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

const schemaPath = fileURLToPath(new URL('../config.schema.json', import.meta.url))
const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))

describe('ticket config', () => {
  test('example is valid and a bad reload keeps the last good file', () => {
    const validate = createValidator(loadSchema(schemaPath))
    assert.equal(parseConfigText(JSON.stringify(example), validate).ok, true)
    const dir = tempDir()
    const filePath = dir.path('config.json')
    writeFileSync(filePath, JSON.stringify(example))
    const store = createConfigStore({
      filePath, schema: loadSchema(schemaPath), logger: silentLogger, watch: false,
    })
    try {
      writeFileSync(filePath, '{')
      assert.equal(store.reloadFromDisk().ok, false)
      assert.equal(store.get().guilds['111111111111111111'].oneActive, true)
      writeFileSync(dir.path('bad.json'), '{')
      assert.throws(() => createConfigStore({
        filePath: dir.path('bad.json'), schema: loadSchema(schemaPath), logger: silentLogger, watch: false,
      }), ConfigError)
    } finally {
      store.close()
      dir.remove()
    }
  })
})
