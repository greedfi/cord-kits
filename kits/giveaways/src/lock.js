import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Single-process file lease. This is not a distributed lock.
// Do not run a second replica, and do not put the data directory on network-shared storage.
export function acquireInstanceLock(filePath, {
  fsImpl = fs,
  now = () => Date.now(),
  leaseMs = 30_000,
  pid = process.pid,
  token = randomBytes(16).toString('hex'),
  onLost = () => {},
} = {}) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
  const body = () => JSON.stringify({ pid, token, expiresAt: now() + leaseMs })
  let lost = false
  let timer = null

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
      const error = new Error('Another process holds the file lease for this data directory. Run one process. Do not run a second replica, and do not put this directory on network-shared storage.')
      error.code = 'LOCKED'
      throw error
    }
    try {
      fsImpl.unlinkSync(filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!create()) {
      const error = new Error('Could not acquire the file lease.')
      error.code = 'LOCKED'
      throw error
    }
  }

  function markLost() {
    if (lost) return
    lost = true
    if (timer) clearInterval(timer)
    timer = null
    try {
      onLost()
    } catch {
      // A lost lease must not throw out of the timer.
    }
  }

  function renew() {
    if (lost) return false
    let current
    try {
      current = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))
    } catch {
      markLost()
      return false
    }
    if (!current || current.token !== token) {
      markLost()
      return false
    }
    try {
      fsImpl.writeFileSync(filePath, body())
    } catch {
      markLost()
      return false
    }
    return true
  }

  timer = setInterval(() => {
    renew()
  }, Math.max(1000, Math.floor(leaseMs / 3)))
  if (typeof timer.unref === 'function') timer.unref()

  return {
    token,
    renew,
    assertHeld() {
      if (renew()) return
      const error = new Error('This process lost the file lease. It will not send or change Discord state. Run one process for this data directory. Do not use a second replica or network-shared storage.')
      error.code = 'LEASE_LOST'
      throw error
    },
    release() {
      if (timer) clearInterval(timer)
      timer = null
      if (lost) return
      try {
        const current = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))
        if (current.token === token) fsImpl.unlinkSync(filePath)
      } catch {
        // The lease file is already gone.
      }
    },
  }
}
