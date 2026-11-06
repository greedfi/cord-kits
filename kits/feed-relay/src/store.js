import fs from 'node:fs'
import path from 'node:path'

export class StoreError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StoreError'
  }
}

function parseObject(text, label) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new StoreError(`${label} is unreadable: ${error.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError(`${label} is not a JSON object`)
  }
  return value
}

export function createJsonStore(filePath, { fsImpl = fs } = {}) {
  let queue = Promise.resolve()
  let cache = null

  function lock(fn) {
    const run = queue.then(fn, fn)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  function readRaw(target) {
    try {
      return fsImpl.readFileSync(target, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  function writeAtomic(data) {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
    const json = `${JSON.stringify(data, null, 2)}\n`
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    fsImpl.writeFileSync(tmp, json)
    if (typeof fsImpl.openSync === 'function' && typeof fsImpl.fsyncSync === 'function') {
      const fd = fsImpl.openSync(tmp, 'r')
      try {
        fsImpl.fsyncSync(fd)
      } finally {
        fsImpl.closeSync(fd)
      }
    }
    const existing = readRaw(filePath)
    if (existing != null) {
      try {
        parseObject(existing, filePath)
        fsImpl.writeFileSync(`${filePath}.bak`, existing)
      } catch {
        // Leave the last good backup in place when the current file is corrupt.
      }
    }
    fsImpl.renameSync(tmp, filePath)
    cache = data
  }

  function loadFromDisk() {
    const main = readRaw(filePath)
    if (main == null) return {}
    try {
      return parseObject(main, filePath)
    } catch (primary) {
      const backupText = readRaw(`${filePath}.bak`)
      if (backupText == null) throw primary
      const recovered = parseObject(backupText, `${filePath}.bak`)
      writeAtomic(recovered)
      return recovered
    }
  }

  return {
    read() {
      return lock(async () => {
        if (!cache) cache = loadFromDisk()
        return structuredClone(cache)
      })
    },
    update(mutator) {
      return lock(async () => {
        if (!cache) cache = loadFromDisk()
        const draft = structuredClone(cache)
        const result = await mutator(draft)
        writeAtomic(structuredClone(draft))
        return result === undefined ? structuredClone(draft) : structuredClone(result)
      })
    },
  }
}
