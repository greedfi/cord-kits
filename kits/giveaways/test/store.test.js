// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { StoreError, createJsonStore } from '../src/store.js'
import { tempDir } from './helpers.js'

describe('json store', () => {
  test('serializes concurrent updates and keeps the previous file as a backup', async () => {
    const dir = tempDir()
    const file = dir.path('giveaways.json')
    try {
      const store = createJsonStore(file)
      await Promise.all(Array.from({ length: 40 }, () => store.update((data) => {
        data.n = (data.n ?? 0) + 1
      })))
      assert.equal((await store.read()).n, 40)
      await assert.rejects(() => store.update(() => {
        throw new Error('nope')
      }), /nope/)
      assert.equal((await store.read()).n, 40)
      const backup = JSON.parse(readFileSync(`${file}.bak`, 'utf8'))
      assert.equal(backup.n, 39)
    } finally {
      dir.remove()
    }
  })

  test('a corrupt main file is replaced from the backup and a corrupt backup refuses to start', async () => {
    const dir = tempDir()
    const file = dir.path('giveaways.json')
    try {
      const store = createJsonStore(file)
      await store.update((data) => {
        data.n = 1
      })
      await store.update((data) => {
        data.n = 2
      })
      writeFileSync(file, '{')
      const recovered = createJsonStore(file)
      assert.equal((await recovered.read()).n, 1)
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).n, 1)
      assert.equal(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).n, 1)
      writeFileSync(file, '{')
      writeFileSync(`${file}.bak`, '{')
      const broken = createJsonStore(file)
      await assert.rejects(() => broken.read(), StoreError)
      assert.equal(readFileSync(file, 'utf8'), '{')
    } finally {
      dir.remove()
    }
  })
})
