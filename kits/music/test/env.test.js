import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, requestChannelEnabled } from '../src/env.js'

describe('env', () => {
  test('redacts the bot token, the SoundCloud id, and client_id query values', () => {
    const previousToken = process.env.DISCORD_BOT_TOKEN
    const previousId = process.env.SOUNDCLOUD_CLIENT_ID
    process.env.DISCORD_BOT_TOKEN = 'secret-token'
    process.env.SOUNDCLOUD_CLIENT_ID = 'a'.repeat(32)
    try {
      const line = redact(`token secret-token id ${'a'.repeat(32)} https://api.example/x?client_id=${'b'.repeat(32)}&ok=1`)
      assert.equal(line.includes('secret-token'), false)
      assert.equal(line.includes('a'.repeat(32)), false)
      assert.equal(line.includes('b'.repeat(32)), false)
      assert.match(line, /client_id=\[redacted\]/)
    } finally {
      if (previousToken === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = previousToken
      if (previousId === undefined) delete process.env.SOUNDCLOUD_CLIENT_ID
      else process.env.SOUNDCLOUD_CLIENT_ID = previousId
    }
  })

  test('the request channel flag is opt-in', () => {
    assert.equal(requestChannelEnabled({}), false)
    assert.equal(requestChannelEnabled({ ENABLE_REQUEST_CHANNEL: 'true' }), true)
    assert.equal(requestChannelEnabled({ ENABLE_REQUEST_CHANNEL: '1' }), true)
    assert.equal(requestChannelEnabled({ ENABLE_REQUEST_CHANNEL: 'false' }), false)
  })
})
