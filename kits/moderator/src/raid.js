import fs from 'node:fs'
import path from 'node:path'

function asSeconds(value) {
  return Number.isInteger(value) ? value : 0
}

export function desiredSlowmodes(raidMode) {
  const desired = new Map()
  if (!raidMode?.enabled) return desired
  for (const id of raidMode.channelIds ?? []) desired.set(id, asSeconds(raidMode.slowmodeSeconds))
  return desired
}

export function planSlowmodeSync(state, desired, readCurrent) {
  const next = new Map()
  const changes = []
  for (const [id, entry] of state) {
    if (!desired.has(id)) changes.push({ id, slowmodeSeconds: entry.previous })
  }
  for (const [id, seconds] of desired) {
    const existing = state.get(id)
    const previous = existing ? existing.previous : asSeconds(readCurrent(id))
    const applied = asSeconds(seconds)
    next.set(id, { previous, applied })
    if (!existing || existing.applied !== applied) {
      changes.push({ id, slowmodeSeconds: applied })
    }
  }
  return { state: next, changes }
}

export function stateAfterApply(previous, preview, failedIds) {
  const failed = failedIds instanceof Set ? failedIds : new Set(failedIds)
  const next = new Map()
  for (const [id, entry] of preview.state) {
    if (failed.has(id)) {
      const prior = previous.get(id)
      if (prior) next.set(id, { previous: prior.previous, applied: prior.applied })
      continue
    }
    next.set(id, { previous: entry.previous, applied: entry.applied })
  }
  for (const [id, entry] of previous) {
    if (preview.state.has(id)) continue
    if (failed.has(id)) next.set(id, { previous: entry.previous, applied: entry.applied })
  }
  return next
}

export async function applyRaidChanges({ prior, preview, setSlowmode }) {
  const failed = []
  for (const change of preview.changes) {
    let ok = false
    try {
      ok = await setSlowmode(change.id, change.slowmodeSeconds)
    } catch {
      ok = false
    }
    if (ok !== true) failed.push(change.id)
  }
  return { state: stateAfterApply(prior, preview, failed), failed }
}

export function describeJoinHold(joinHold) {
  if (!joinHold || joinHold.type === 'off') {
    return 'Join hold is off. Raid mode does not time out or assign a role.'
  }
  if (joinHold.type === 'timeout') {
    return `New joins are timed out for ${joinHold.timeoutMinutes} minute(s) only when the bot has Moderate Members and Discord reports that member as moderatable.`
  }
  if (joinHold.type === 'role' && joinHold.roleId) {
    return `New joins are assigned <@&${joinHold.roleId}> only when the bot has Manage Roles, its highest role is above that role, and the role is not managed, @everyone, or elevated. Raid mode does not edit channel overwrites. The role blocks access only where that role already denies it.`
  }
  if (joinHold.type === 'role') {
    return 'Join hold is set to a role, but roleId is missing, so no role is assigned.'
  }
  return 'Join hold is off.'
}

export function joinHoldAction(raidMode) {
  if (!raidMode?.enabled) return { type: 'off' }
  const hold = raidMode.joinHold ?? {}
  if (hold.type === 'timeout') {
    const minutes = hold.timeoutMinutes
    return { type: 'timeout', minutes, timeoutMs: minutes * 60 * 1000 }
  }
  if (hold.type === 'role') {
    if (!hold.roleId) return { type: 'error', error: 'role_missing' }
    return { type: 'role', roleId: hold.roleId }
  }
  return { type: 'off' }
}

function readSnapshots(fsImpl, filePath) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Ignoring raid snapshot: ${error.message}`)
    return null
  }
}

function snapshotEntry(entry) {
  if (!entry || !Number.isInteger(entry.previous) || !Number.isInteger(entry.applied)) return null
  return { previous: entry.previous, applied: entry.applied }
}

export function createRaidSync({ filePath, fsImpl = fs } = {}) {
  const states = new Map()
  const stored = filePath ? readSnapshots(fsImpl, filePath) : null
  for (const [guildId, entries] of Object.entries(stored ?? {})) {
    if (!entries || typeof entries !== 'object') continue
    const map = new Map()
    for (const [channelId, entry] of Object.entries(entries)) {
      const clean = snapshotEntry(entry)
      if (clean) map.set(channelId, clean)
    }
    if (map.size > 0) states.set(guildId, map)
  }

  function persist() {
    if (!filePath) return
    const out = {}
    for (const [guildId, map] of states) {
      if (map.size === 0) continue
      out[guildId] = Object.fromEntries(map)
    }
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    fsImpl.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`)
    fsImpl.renameSync(tmp, filePath)
  }

  return {
    preview(guildId, desired, readCurrent) {
      return planSlowmodeSync(states.get(guildId) ?? new Map(), desired, readCurrent)
    },
    commit(guildId, nextState) {
      const map = nextState instanceof Map ? nextState : new Map()
      states.set(guildId, map)
      persist()
    },
    plan(guildId, desired, readCurrent) {
      const result = planSlowmodeSync(states.get(guildId) ?? new Map(), desired, readCurrent)
      states.set(guildId, result.state)
      persist()
      return result
    },
    state(guildId) {
      return states.get(guildId) ?? new Map()
    },
  }
}
