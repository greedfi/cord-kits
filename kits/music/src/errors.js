import { ConfigError } from './config.js'
import { SourceError } from './sources.js'
import { redact } from './env.js'

export class UserError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UserError'
  }
}

export function publicMessage(error) {
  if (error instanceof SourceError || error instanceof UserError || error instanceof ConfigError) {
    return redact(String(error.message)).slice(0, 300)
  }
  return 'Command failed.'
}
