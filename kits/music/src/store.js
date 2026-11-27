import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function readJsonFile(file, fsImpl = fs) {
  const bak = `${file}.bak`
  let text
  try {
    text = fsImpl.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    let backup
    try {
      backup = fsImpl.readFileSync(bak, 'utf8')
    } catch (backupError) {
      if (backupError.code === 'ENOENT') throw error
      throw error
    }
    return JSON.parse(backup)
  }
}

export function writeJsonAtomic(file, value, fsImpl = fs) {
  const dir = path.dirname(file)
  fsImpl.mkdirSync(dir, { recursive: true })
  const text = `${JSON.stringify(value, null, 2)}\n`
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const fd = fsImpl.openSync(tmp, 'w')
  try {
    fsImpl.writeSync(fd, text)
    if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(fd)
  } finally {
    fsImpl.closeSync(fd)
  }
  if (fsImpl.existsSync(file)) fsImpl.copyFileSync(file, `${file}.bak`)
  fsImpl.renameSync(tmp, file)
}
