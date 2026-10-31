import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cord-kits-'))
  return {
    dir,
    path(...parts) {
      return path.join(dir, ...parts)
    },
    remove() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function waitFor(predicate, timeout = 3000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      let value
      try {
        value = predicate()
      } catch (error) {
        clearInterval(timer)
        reject(error)
        return
      }
      if (value) {
        clearInterval(timer)
        resolve(value)
      } else if (Date.now() - start > timeout) {
        clearInterval(timer)
        reject(new Error('timed out waiting for condition'))
      }
    }, 20)
  })
}

export const silentLogger = {
  info() {},
  error() {},
}
