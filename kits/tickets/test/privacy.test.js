// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import {
  canReadTranscript,
  canViewTicket,
  ticketOverwrites,
  transcriptPath,
} from '../src/privacy.js'

const GUILD = '111111111111111111'
const OPENER = '222222222222222222'
const STAFF = '333333333333333333'
const BOT = '444444444444444444'
const STRANGER = '555555555555555555'

describe('ticket privacy model', () => {
  test('everyone is denied view, and only opener, staff, and the bot are allowed', () => {
    const overwrites = ticketOverwrites({
      everyoneId: GUILD,
      openerId: OPENER,
      staffRoleId: STAFF,
      botId: BOT,
    })
    const everyone = overwrites.find((entry) => entry.id === GUILD)
    assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel))
    assert.equal(everyone.allow, undefined)
    assert.deepEqual(canViewTicket({
      userId: STRANGER,
      roleIds: ['999999999999999999'],
      openerId: OPENER,
      staffRoleId: STAFF,
      botId: BOT,
    }), { view: false, reason: 'overwrite_deny' })
    assert.equal(canViewTicket({
      userId: OPENER, roleIds: [], openerId: OPENER, staffRoleId: STAFF, botId: BOT,
    }).view, true)
    assert.equal(canViewTicket({
      userId: STRANGER, roleIds: [STAFF], openerId: OPENER, staffRoleId: STAFF, botId: BOT,
    }).reason, 'staff')
    assert.equal(canViewTicket({
      userId: STRANGER,
      roleIds: [],
      administrator: true,
      openerId: OPENER,
      staffRoleId: STAFF,
      botId: BOT,
    }).reason, 'administrator_bypass')
  })

  test('transcripts require the staff role and reject path traversal', () => {
    assert.equal(canReadTranscript({ roleIds: [STAFF], staffRoleId: STAFF }), true)
    assert.equal(canReadTranscript({ roleIds: [], staffRoleId: STAFF }), false)
    assert.equal(canReadTranscript({ roleIds: [], administrator: true, staffRoleId: STAFF }), false)
    const file = transcriptPath('/data', GUILD, 'abc123abc123')
    assert.equal(file, '/data/transcripts/111111111111111111/abc123abc123.txt')
    assert.throws(() => transcriptPath('/data', GUILD, '../secrets'), /Bad ticket/)
    assert.throws(() => transcriptPath('/data', '../etc', 'abc123abc123'), /Bad guild/)
  })
})
