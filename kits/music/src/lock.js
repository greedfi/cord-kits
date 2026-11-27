import fs from 'node:fs'
import path from 'node:path'

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function acquireLock(dir, fsImpl = fs) {
  fsImpl.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'process.lock')
  const write = (flags) => {
    const fd = fsImpl.openSync(file, flags)
    fsImpl.writeSync(fd, `${process.pid}\n`)
    return {
      file,
      release() {
        fsImpl.closeSync(fd)
        try {
          const current = Number(String(fsImpl.readFileSync(file, 'utf8')).split('\n')[0])
          if (current === process.pid) fsImpl.unlinkSync(file)
        } catch {
          // The lock file is already gone.
        }
      },
    }
  }
  try {
    return write('wx')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number(String(fsImpl.readFileSync(file, 'utf8')).split('\n')[0])
    if (alive(pid)) {
      throw new Error(`Another music process (pid ${pid}) is using ${dir}. Run one process per data directory.`)
    }
    fsImpl.unlinkSync(file)
    return write('wx')
  }
}
