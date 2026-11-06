// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { assessJoinHoldRole, assessJoinHoldTimeout } from '../src/guard.js'

const GUILD = '111111111111111111'

function role(partial) {
  const granted = new Set(partial.grants ?? [])
  return {
    id: partial.id ?? '555555555555555555',
    managed: partial.managed ?? false,
    position: partial.position ?? 1,
    permissions: {
      has(bit) {
        for (const name of granted) {
          if (PermissionFlagsBits[name] === bit) return true
        }
        return false
      },
    },
  }
}

describe('join-hold role gate', () => {
  test('rejects missing permissions, managed roles, everyone, hierarchy, and elevated roles', () => {
    const base = { botHasManageRoles: true, botHighest: 10, guildId: GUILD }
    assert.equal(assessJoinHoldRole(role({}), { ...base, botHasManageRoles: false }).reason, 'missing_manage_roles')
    assert.equal(assessJoinHoldRole(null, base).reason, 'missing_role')
    assert.equal(assessJoinHoldRole(role({ managed: true }), base).reason, 'managed')
    assert.equal(assessJoinHoldRole(role({ id: GUILD }), base).reason, 'everyone')
    assert.equal(assessJoinHoldRole(role({ position: 10 }), base).reason, 'hierarchy')
    assert.equal(assessJoinHoldRole(role({ position: 11 }), base).reason, 'hierarchy')
    const elevated = assessJoinHoldRole(role({ grants: ['Administrator'] }), base)
    assert.equal(elevated.reason, 'elevated')
    assert.ok(elevated.permissions.includes('Administrator'))
    assert.equal(assessJoinHoldRole(role({ grants: ['ModerateMembers'] }), base).reason, 'elevated')
    assert.equal(assessJoinHoldRole(role({ grants: ['MentionEveryone'] }), base).reason, 'elevated')
    assert.deepEqual(assessJoinHoldRole(role({ position: 2 }), base), { ok: true })
  })
})

describe('join-hold timeout', () => {
  test('trusts moderatable when Discord provides it and falls back to hierarchy', () => {
    const base = {
      botHasModerate: true,
      botId: '222222222222222222',
      ownerId: '333333333333333333',
      botHighest: 10,
    }
    assert.equal(assessJoinHoldTimeout({
      ...base,
      botHasModerate: false,
      member: { id: '4', moderatable: true },
    }).reason, 'missing_moderate_members')
    assert.equal(assessJoinHoldTimeout({
      ...base,
      member: { id: '4', moderatable: false },
    }).reason, 'not_moderatable')
    assert.deepEqual(assessJoinHoldTimeout({
      ...base,
      member: { id: '4', moderatable: true, roles: { highest: { position: 99 } } },
    }), { ok: true })
    assert.equal(assessJoinHoldTimeout({
      ...base,
      member: { id: '4', roles: { highest: { position: 10 } } },
    }).reason, 'hierarchy')
    assert.equal(assessJoinHoldTimeout({
      ...base,
      member: { id: base.ownerId },
    }).reason, 'owner')
    assert.deepEqual(assessJoinHoldTimeout({
      ...base,
      member: { id: '4', roles: { highest: { position: 3 } } },
    }), { ok: true })
  })
})
