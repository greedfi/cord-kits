import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDependencyReport } from '@discordjs/voice'
import { Client, Events } from 'discord.js'
import { configFilePath, createConfigStore, createLogger, loadSchema } from './config.js'
import { isDirectRun, loadEnv, redact, requestChannelEnabled, requireEnv } from './env.js'
import { gatewayIntents, inviteUrl } from './permissions.js'
import { attachClient, createRuntime } from './runtime.js'

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
  const requestChannel = requestChannelEnabled()
  const client = new Client({
    intents: gatewayIntents(requestChannel),
    allowedMentions: { parse: [] },
  })
  const runtime = createRuntime({ config, client, requestChannel })
  attachClient(client, runtime)
  client.once(Events.ClientReady, (ready) => {
    console.log(`Logged in as ${ready.user.tag}`)
    const clientId = process.env.CLIENT_ID?.trim()
    if (clientId) console.log(`Invite: ${inviteUrl(clientId)}`)
    runtime.restore().catch((error) => {
      console.error(redact(error instanceof Error ? error.message : error))
    })
  })
  try {
    console.log(generateDependencyReport())
  } catch (error) {
    console.error(`Voice dependency check failed: ${error.message}`)
  }
  const shutdown = () => {
    runtime.shutdown()
    config.close()
    client.destroy()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await client.login(token)
  return { client, config, runtime }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    console.error(redact(error.message ?? error))
    process.exit(1)
  })
}
