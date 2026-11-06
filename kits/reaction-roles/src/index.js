import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, GatewayIntentBits } from 'discord.js'
import { configFilePath, createConfigStore, createLogger, loadSchema } from './config.js'
import { isDirectRun, loadEnv, redact, requireEnv } from './env.js'
import { acquireInstanceLock } from './lock.js'
import { dataPaths } from './paths.js'
import { createRuntime } from './runtime.js'
import { createJsonStore } from './store.js'

const kitRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function main() {
  loadEnv()
  const token = requireEnv('DISCORD_BOT_TOKEN')
  const filePath = configFilePath()
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. Copy config.example.json to config.json and edit it.`)
  }
  const config = createConfigStore({
    filePath,
    schema: loadSchema(path.join(kitRoot, 'config.schema.json')),
    logger: createLogger(),
  })
  const paths = dataPaths()
  const lock = acquireInstanceLock(paths.lock)
  const store = createJsonStore(paths.store)
  const runtime = createRuntime({ configStore: config, store })
  const client = new Client({ intents: [GatewayIntentBits.Guilds] })
  runtime.bind(client)
  const shutdown = () => {
    lock.release()
    config.close()
    client.destroy()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    await client.login(token)
  } catch (error) {
    lock.release()
    config.close()
    throw error
  }
  return { client, config, runtime }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    console.error(redact(error.message ?? error))
    process.exit(1)
  })
}
