// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import {
  outsideRolesUntouched,
  planSelection,
  planToggle,
  roleBlock,
} from '../src/roles.js'

const GUILD = '111111111111111111'

function role(partial = {}) {
  const grants = new Set(partial.grants ?? [])
  return {
    id: partial.id ?? '555555555555555555',
    managed: partial.managed ?? false,
    position: partial.position ?? 1,
    permissions: {
      has(bit) {
        for (const name of grants) {
          if (PermissionFlagsBits[name] === bit) return true
        }
        return false
      },
    },
  }
}

describe('role safety', () => {
  test('refuses elevated, managed, everyone, hierarchy, and a bot without Manage Roles', () => {
    const base = { botHasManageRoles: true, botHighest: 10, guildId: GUILD }
    assert.equal(roleBlock(role({ grants: ['Administrator'] }), base).reason, 'elevated')
    assert.equal(roleBlock(role({ grants: ['ModerateMembers'] }), base).reason, 'elevated')
    assert.equal(roleBlock(role({ grants: ['MentionEveryone'] }), base).reason, 'elevated')
    assert.equal(roleBlock(role({ managed: true }), base).reason, 'managed')
    assert.equal(roleBlock(role({ id: GUILD }), base).reason, 'everyone')
    assert.equal(roleBlock(role({ position: 10 }), base).reason, 'hierarchy')
    assert.equal(roleBlock(role({}), { ...base, botHasManageRoles: false }).reason, 'missing_manage_roles')
    assert.equal(roleBlock(null, base).reason, 'missing_role')
    assert.deepEqual(roleBlock(role({ position: 2 }), base), { ok: true })
  })

  test('exclusive swap and select replacement leave roles from outside the panel alone', () => {
    const toggle = planToggle({
      memberRoleIds: ['outside', 'a'],
      panelRoleIds: ['a', 'b'],
      roleId: 'b',
      exclusive: true,
      maxRoles: 1,
    })
    assert.deepEqual(toggle, { ok: true, add: ['b'], remove: ['a'] })
    assert.equal(outsideRolesUntouched(['outside', 'a'], ['a', 'b'], toggle), true)
    const capped = planToggle({
      memberRoleIds: ['a', 'b'],
      panelRoleIds: ['a', 'b', 'c'],
      roleId: 'c',
      exclusive: false,
      maxRoles: 2,
    })
    assert.equal(capped.reason, 'max')
    const selected = planSelection({
      memberRoleIds: ['outside', 'a'],
      panelRoleIds: ['a', 'b'],
      selectedIds: ['b', 'not-on-panel'],
      maxRoles: 1,
    })
    assert.deepEqual(selected, { ok: true, add: ['b'], remove: ['a'] })
    assert.equal(outsideRolesUntouched(['outside', 'a'], ['a', 'b'], selected), true)
  })
})
