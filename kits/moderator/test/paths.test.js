// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { dataDirectory } from '../src/paths.js'

describe('data directory', () => {
  test('defaults beside the working directory and honors DATA_DIR', () => {
    assert.equal(dataDirectory({}, '/app'), path.join('/app', 'data'))
    assert.equal(dataDirectory({ DATA_DIR: '  ' }, '/app'), path.join('/app', 'data'))
    assert.equal(dataDirectory({ DATA_DIR: '/var/cord' }, '/app'), path.resolve('/var/cord'))
  })
})
