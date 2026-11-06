import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function acquireInstanceLock(filePath, {
  fsImpl = fs,
  now = () => Date.now(),
  leaseMs = 30_000,
  pid = process.pid,
  token = randomBytes(16).toString('hex'),
} = {}) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
  const body = () => JSON.stringify({ pid, token, expiresAt: now() + leaseMs })

  function create() {
    let fd
    try {
      fd = fsImpl.openSync(filePath, 'wx')
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
    try {
      fsImpl.writeFileSync(fd, body())
    } finally {
      fsImpl.closeSync(fd)
    }
    return true
  }

  if (!create()) {
    let current = null
    try {
      current = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))
    } catch {
      current = null
    }
    const held = current
      && Number.isFinite(current.expiresAt)
      && current.expiresAt > now()
      && current.token !== token
    if (held) {
      const error = new Error('Another instance holds the data lock. Run one replica against this data directory.')
      error.code = 'LOCKED'
      throw error
    }
    try {
      fsImpl.unlinkSync(filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!create()) {
      const error = new Error('Could not acquire the data lock.')
      error.code = 'LOCKED'
      throw error
    }
  }

  const timer = setInterval(() => {
    try {
      const current = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))
      if (current.token !== token) return
      fsImpl.writeFileSync(filePath, body())
    } catch {
      // A later tick or the next process start reports a lost lock.
    }
  }, Math.max(1000, Math.floor(leaseMs / 3)))
  if (typeof timer.unref === 'function') timer.unref()

  return {
    token,
    release() {
      clearInterval(timer)
      try {
        const current = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))
        if (current.token === token) fsImpl.unlinkSync(filePath)
      } catch {
        // The lock file is already gone.
      }
    },
  }
}
