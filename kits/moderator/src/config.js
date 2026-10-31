import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import Ajv from 'ajv'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function createLogger(sink = console) {
  const write = (level, message) => {
    const line = `${new Date().toISOString()} ${level} ${message}`
    if (level === 'error') sink.error(line)
    else sink.info(line)
  }
  return {
    info(message) {
      write('info', message)
    },
    error(message) {
      write('error', message)
    },
  }
}

export function formatAjvErrors(errors = []) {
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ')
}

export function createValidator(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  return ajv.compile(structuredClone(schema))
}

export function parseConfigText(text, validate) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${error.message}` }
  }
  const copy = structuredClone(data)
  if (!validate(copy)) {
    return {
      ok: false,
      error: `Config schema validation failed: ${formatAjvErrors(validate.errors)}`,
    }
  }
  return { ok: true, config: data }
}

export function loadSchema(schemaPath, fsImpl = fs) {
  return JSON.parse(fsImpl.readFileSync(schemaPath, 'utf8'))
}

export function configFilePath() {
  return process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : path.join(process.cwd(), 'config.json')
}

function writeAtomic(fsImpl, filePath, text) {
  const tmp = `${filePath}.${process.pid}.tmp`
  fsImpl.writeFileSync(tmp, text)
  fsImpl.renameSync(tmp, filePath)
}

export function createConfigStore({
  filePath,
  schema,
  logger = createLogger(),
  fsImpl = fs,
  watch = true,
  debounceMs = 50,
}) {
  const validate = createValidator(schema)
  const emitter = new EventEmitter()
  let current = null
  let timer = null
  let closed = false
  let watcher = { close() {} }

  function commit(config) {
    const same = current != null && JSON.stringify(current) === JSON.stringify(config)
    current = config
    if (!same && current != null) {
      logger.info(`Config reloaded from ${filePath}.`)
      emitter.emit('reload', current)
    }
    return { ok: true, config: current }
  }

  function applyText(text, { initial = false } = {}) {
    const result = parseConfigText(text, validate)
    if (!result.ok) {
      if (initial || current == null) throw new ConfigError(result.error)
      logger.error(`Config reload failed (${result.error}). Keeping last good config.`)
      return { ok: false, error: result.error, config: current }
    }
    if (initial) {
      current = result.config
      return { ok: true, config: current }
    }
    return commit(result.config)
  }

  function read() {
    return fsImpl.readFileSync(filePath, 'utf8')
  }

  function reloadFromDisk() {
    let text
    try {
      text = read()
    } catch (error) {
      if (current == null) throw error
      logger.error(`Config reload failed (${error.message}). Keeping last good config.`)
      return { ok: false, error: error.message, config: current }
    }
    return applyText(text)
  }

  applyText(read(), { initial: true })

  function schedule() {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!closed) reloadFromDisk()
    }, debounceMs)
  }

  if (watch) {
    const dir = path.dirname(path.resolve(filePath))
    const base = path.basename(filePath)
    watcher = fsImpl.watch(dir, { persistent: true }, (_event, filename) => {
      const name = filename == null ? null : filename.toString()
      if (name != null && name !== base) return
      schedule()
    })
  }

  return {
    get() {
      return current
    },
    reloadFromDisk,
    update(mutator) {
      const draft = structuredClone(current)
      const returned = mutator(draft)
      const next = returned ?? draft
      const text = `${JSON.stringify(next, null, 2)}\n`
      const result = parseConfigText(text, validate)
      if (!result.ok) throw new ConfigError(result.error)
      writeAtomic(fsImpl, filePath, text)
      return commit(result.config)
    },
    onReload(listener) {
      emitter.on('reload', listener)
      return () => emitter.off('reload', listener)
    },
    close() {
      closed = true
      clearTimeout(timer)
      watcher.close()
    },
  }
}
