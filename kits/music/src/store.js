import fs from 'node:fs'
import path from 'node:path'

function isMissing(error) {
  return error?.code === 'ENOENT'
}

export function readJsonWithBackup(filePath, fsImpl = fs) {
  const backup = `${filePath}.bak`
  let mainError = null
  if (fsImpl.existsSync(filePath)) {
    try {
      return { ok: true, source: 'main', data: JSON.parse(fsImpl.readFileSync(filePath, 'utf8')) }
    } catch (error) {
      mainError = error
    }
  } else {
    mainError = Object.assign(new Error('missing'), { code: 'ENOENT' })
  }
  if (fsImpl.existsSync(backup)) {
    try {
      const data = JSON.parse(fsImpl.readFileSync(backup, 'utf8'))
      return { ok: true, source: 'backup', data, mainError }
    } catch (error) {
      return { ok: false, error, mainError }
    }
  }
  if (isMissing(mainError) && !fsImpl.existsSync(filePath)) return { ok: true, source: 'empty', data: null }
  return { ok: false, error: mainError, mainError }
}

export function atomicWriteJson(filePath, data, fsImpl = fs, { backup = true } = {}) {
  const text = `${JSON.stringify(data, null, 2)}\n`
  const dir = path.dirname(filePath)
  fsImpl.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  const fd = fsImpl.openSync(tmp, 'w')
  try {
    fsImpl.writeSync(fd, text)
    fsImpl.fsyncSync(fd)
  } finally {
    fsImpl.closeSync(fd)
  }
  // Restoring a backup must not copy a corrupt main file over the good .bak.
  if (backup && fsImpl.existsSync(filePath)) fsImpl.copyFileSync(filePath, `${filePath}.bak`)
  fsImpl.renameSync(tmp, filePath)
}

export function createJsonStore(filePath, { fsImpl = fs, fallback, validate } = {}) {
  let chain = Promise.resolve()
  let cache = null
  let damaged = false
  let damageError = null

  function load() {
    const result = readJsonWithBackup(filePath, fsImpl)
    if (!result.ok) {
      damaged = true
      damageError = result.error
      cache = fallback()
      return
    }
    const data = result.data ?? fallback()
    if (validate && !validate(data)) {
      damaged = true
      damageError = new Error('Saved data did not match the expected shape.')
      cache = fallback()
      return
    }
    damaged = false
    damageError = null
    cache = data
    if (result.source === 'backup') atomicWriteJson(filePath, cache, fsImpl, { backup: false })
  }

  load()

  function update(mutator) {
    const run = chain.then(async () => {
      if (damaged) {
        const error = new Error('Saved data is damaged. Fix or remove the data file and its .bak before writing.')
        error.cause = damageError
        throw error
      }
      const next = await mutator(structuredClone(cache))
      if (validate && !validate(next)) throw new Error('Refusing to write an invalid data file.')
      atomicWriteJson(filePath, next, fsImpl)
      cache = next
      return structuredClone(cache)
    })
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    get() {
      return structuredClone(cache)
    },
    damaged() {
      return damaged
    },
    update,
    close() {},
  }
}
