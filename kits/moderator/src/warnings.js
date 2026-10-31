import fs from 'node:fs'
import path from 'node:path'

export function addWarning(data, input) {
  const reason = String(input.reason ?? '').trim().slice(0, 512)
  if (!reason) throw new Error('Warning reason is required.')
  const guild = Array.isArray(data[input.guildId]) ? [...data[input.guildId]] : []
  const id = guild.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0) + 1
  const entry = {
    id,
    userId: input.userId,
    moderatorId: input.moderatorId,
    reason,
    at: input.at ?? new Date().toISOString(),
  }
  guild.push(entry)
  const next = { ...data, [input.guildId]: guild }
  return {
    data: next,
    entry,
    count: guild.filter((item) => item.userId === input.userId).length,
  }
}

export function warningsFor(data, guildId, userId) {
  return (data[guildId] ?? []).filter((entry) => entry.userId === userId)
}

function readStore(filePath, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Warning store ${filePath} is not a JSON object.`)
    }
    return parsed
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

export function createWarningStore(filePath, fsImpl = fs) {
  let data = readStore(filePath, fsImpl)
  return {
    list(guildId, userId) {
      return warningsFor(data, guildId, userId)
    },
    add(input) {
      const result = addWarning(data, input)
      data = result.data
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
      const tmp = `${filePath}.${process.pid}.tmp`
      fsImpl.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
      fsImpl.renameSync(tmp, filePath)
      return result
    },
  }
}
