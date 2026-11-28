import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { voiceStatusRequest } from '../src/voice-status.js'

function channel(permissions) {
  return {
    id: '444444444444444444',
    type: ChannelType.GuildVoice,
    guild: { members: { me: { id: '999999999999999999' } } },
    permissionsFor() {
      return new PermissionsBitField(permissions)
    },
  }
}

describe('voice channel status', () => {
  test('asks Discord only when the bot is connected and holds Set Voice Channel Status', () => {
    const missing = voiceStatusRequest(channel([PermissionFlagsBits.Connect]), 'Hello')
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'missing_permission')
    const stage = voiceStatusRequest({ ...channel([PermissionFlagsBits.SetVoiceChannelStatus]), type: ChannelType.GuildStageVoice }, 'Hello')
    assert.equal(stage.reason, 'unsupported')
    const allowed = voiceStatusRequest(channel([PermissionFlagsBits.SetVoiceChannelStatus]), 'x'.repeat(800))
    assert.equal(allowed.ok, true)
    assert.equal(allowed.route, '/channels/444444444444444444/voice-status')
    assert.equal(allowed.body.status.length <= 500, true)
    const cleared = voiceStatusRequest(channel([PermissionFlagsBits.SetVoiceChannelStatus]), null)
    assert.equal(cleared.body.status, null)
  })
})
